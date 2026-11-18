#include "RealtimeEffects.h"

#include <juce_dsp/juce_dsp.h>

namespace raven
{

using dsp::Biquad;
using dsp::Target;

static constexpr double smoothing = 0.015;  // o ramp() de realtime.js usa setTargetAtTime(…, 0.015)
static constexpr int controlRate = 32;       // filtros recalculam coeficientes a cada 32 amostras

//==============================================================================
RealtimeEffect::RealtimeEffect (juce::String typeIn, juce::StringArray keysIn)
    : type (std::move (typeIn)), keys (std::move (keysIn))
{
    jassert (keys.size() <= (int) params.size());
}

void RealtimeEffect::setState (const juce::var& values, bool isEnabled)
{
    for (int i = 0; i < keys.size(); ++i)
    {
        const auto& v = values[juce::Identifier (keys[i])];
        if (v.isVoid())
            continue;

        // Único parâmetro de texto: o tipo do Filtro ("lowpass" | "highpass").
        const float value = v.isString() ? (v.toString() == "highpass" ? 1.0f : 0.0f)
                                         : static_cast<float> (v);
        params[(size_t) i].store (value, std::memory_order_relaxed);
    }

    enabled.store (isEnabled);
    onParamsChanged();
}

void RealtimeEffect::prepare (double newSampleRate, int maxBlockSize)
{
    sampleRate = newSampleRate;
    dry.setSize (2, maxBlockSize);
    wet.prepare (sampleRate, smoothing);
    prepareEffect (maxBlockSize);
    reset();
}

void RealtimeEffect::reset()
{
    wet.snap (enabled.load() ? 1.0f : 0.0f);
    resetEffect();
}

void RealtimeEffect::process (juce::AudioBuffer<float>& buffer, int numSamples)
{
    wet.target = enabled.load() ? 1.0f : 0.0f;
    const bool fullyWet = wet.settled() && wet.value == 1.0f;

    if (! fullyWet)
        for (int c = 0; c < 2; ++c)
            dry.copyFrom (c, 0, buffer, c, 0, numSamples);

    // Desligado, o efeito continua processando (como no navegador), para a cauda
    // não sumir de repente ao religar.
    processEffect (buffer, numSamples);

    if (fullyWet)
        return;

    auto* l = buffer.getWritePointer (0);
    auto* r = buffer.getWritePointer (1);
    const auto* dl = dry.getReadPointer (0);
    const auto* dr = dry.getReadPointer (1);

    for (int i = 0; i < numSamples; ++i)
    {
        const float w = wet.next();
        l[i] = w * l[i] + (1.0f - w) * dl[i];
        r[i] = w * r[i] + (1.0f - w) * dr[i];
    }
}

//==============================================================================
namespace
{

class GainEffect final : public RealtimeEffect
{
public:
    GainEffect() : RealtimeEffect ("gain", { "gain" }) {}

private:
    void prepareEffect (int) override { gain.prepare (sampleRate, smoothing); }
    void resetEffect() override       { gain.snap (dsp::dbToGain (param (0))); }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        gain.target = dsp::dbToGain (param (0));
        auto* l = buffer.getWritePointer (0);
        auto* r = buffer.getWritePointer (1);
        for (int i = 0; i < n; ++i)
        {
            const float g = gain.next();
            l[i] *= g;
            r[i] *= g;
        }
    }

    Target gain;
};

//==============================================================================
// Graves e Agudos: prateleiras em 250 Hz e 4 kHz e um ganho (BassTrebleBase.cpp).
class BassTrebleEffect final : public RealtimeEffect
{
public:
    BassTrebleEffect() : RealtimeEffect ("bassTreble", { "bass", "treble", "gain" }) {}

private:
    void prepareEffect (int) override
    {
        bass.prepare (sampleRate, smoothing);
        treble.prepare (sampleRate, smoothing);
        gain.prepare (sampleRate, smoothing);
    }

    void resetEffect() override
    {
        bass.snap (param (0));
        treble.snap (param (1));
        gain.snap (dsp::dbToGain (param (2)));
        lo.reset();
        hi.reset();
        updateFilters();
    }

    void updateFilters()
    {
        lo.set (Biquad::Type::lowshelf, 250.0, 1.0, bass.value, sampleRate);
        hi.set (Biquad::Type::highshelf, 4000.0, 1.0, treble.value, sampleRate);
    }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        bass.target = param (0);
        treble.target = param (1);
        gain.target = dsp::dbToGain (param (2));
        auto* ch = buffer.getArrayOfWritePointers();

        for (int i = 0; i < n; ++i)
        {
            bass.next();
            treble.next();
            if (i % controlRate == 0)
                updateFilters();

            const float g = gain.next();
            for (int c = 0; c < 2; ++c)
                ch[c][i] = hi.process (lo.process (ch[c][i], c), c) * g;
        }
    }

    Biquad lo, hi;
    Target bass, treble, gain;
};

//==============================================================================
// Filtro passa-baixa/passa-alta de 12 a 48 dB/oitava: quatro estágios fixos, os
// que sobram viram passa-tudo, como em realtime.js.
class FilterEffect final : public RealtimeEffect
{
public:
    FilterEffect() : RealtimeEffect ("filter", { "type", "freq", "order" }) {}

private:
    void prepareEffect (int) override { freq.prepare (sampleRate, smoothing); }

    void resetEffect() override
    {
        freq.snap (cutoff());
        for (auto& s : stages)
            s.reset();
        updateFilters();
    }

    float cutoff() const { return juce::jmin (param (1), (float) (sampleRate / 2 - 1)); }

    void updateFilters()
    {
        const auto passType = param (0) >= 0.5f ? Biquad::Type::highpass : Biquad::Type::lowpass;
        const int order = juce::jlimit (1, 4, (int) param (2));

        for (int s = 0; s < 4; ++s)
            stages[(size_t) s].set (s < order ? passType : Biquad::Type::allpass,
                                    freq.value, juce::MathConstants<double>::sqrt2 / 2, 0.0, sampleRate);
    }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        freq.target = cutoff();
        auto* ch = buffer.getArrayOfWritePointers();

        for (int i = 0; i < n; ++i)
        {
            freq.next();
            if (i % controlRate == 0)
                updateFilters();

            for (int c = 0; c < 2; ++c)
            {
                float x = ch[c][i];
                for (auto& s : stages)
                    x = s.process (x, c);
                ch[c][i] = x;
            }
        }
    }

    std::array<Biquad, 4> stages;
    Target freq;
};

//==============================================================================
// Eco: y[n] = x[n] + decay · y[n − D], o mesmo laço de realimentação do EchoBase.
class EchoEffect final : public RealtimeEffect
{
public:
    EchoEffect() : RealtimeEffect ("echo", { "delay", "decay" }) {}

private:
    void prepareEffect (int) override
    {
        line.setSize (2, (int) (sampleRate * 5.1) + 4);
        delay.prepare (sampleRate, smoothing);
        decay.prepare (sampleRate, smoothing);
    }

    void resetEffect() override
    {
        line.clear();
        writeIndex = 0;
        delay.snap (param (0) * (float) sampleRate);
        decay.snap (param (1));
    }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        delay.target = juce::jlimit (1.0f, (float) (line.getNumSamples() - 2), param (0) * (float) sampleRate);
        decay.target = param (1);
        const int size = line.getNumSamples();
        auto* ch = buffer.getArrayOfWritePointers();

        for (int i = 0; i < n; ++i)
        {
            const float d = delay.next();
            const float fb = decay.next();

            // Leitura fracionária: mudar o atraso desliza o tempo, como o DelayNode.
            double readPos = writeIndex - (double) d;
            while (readPos < 0)
                readPos += size;
            const int i0 = (int) readPos;
            const int i1 = (i0 + 1) % size;
            const float frac = (float) (readPos - i0);

            for (int c = 0; c < 2; ++c)
            {
                auto* data = line.getWritePointer (c);
                const float delayed = data[i0] + (data[i1] - data[i0]) * frac;
                const float y = ch[c][i] + fb * delayed;
                data[writeIndex] = y;
                ch[c][i] = y;
            }

            writeIndex = (writeIndex + 1) % size;
        }
    }

    juce::AudioBuffer<float> line;
    int writeIndex = 0;
    Target delay, decay;
};

//==============================================================================
// Reverb por convolução com resposta ao impulso sintética (ruído com decaimento),
// normalizada como o ConvolverNode do navegador.
class ReverbEffect final : public RealtimeEffect
{
public:
    ReverbEffect() : RealtimeEffect ("reverb", { "time", "damping", "wet", "dry" }) {}

    void waitUntilReady() override
    {
        // A resposta ao impulso é carregada num thread do JUCE e entra durante o
        // process(): processa silêncio até ela entrar e o crossfade terminar.
        juce::AudioBuffer<float> silence (2, maxBlock);
        juce::dsp::AudioBlock<float> block (silence);

        for (int i = 0; i < 300 && conv.getCurrentIRSize() == 0; ++i)
        {
            silence.clear();
            conv.process (juce::dsp::ProcessContextReplacing<float> (block));
            juce::Thread::sleep (10);
        }

        for (int i = 0; i < (int) (sampleRate * 0.2) / maxBlock + 1; ++i)
        {
            silence.clear();
            conv.process (juce::dsp::ProcessContextReplacing<float> (block));
        }

        conv.reset();
    }

private:
    void onParamsChanged() override
    {
        if (prepared)
            loadImpulseIfChanged();
    }

    void prepareEffect (int maxBlockSize) override
    {
        maxBlock = maxBlockSize;
        wetBuffer.setSize (2, maxBlockSize);
        conv.prepare ({ sampleRate, (juce::uint32) maxBlockSize, 2 });
        wetGain.prepare (sampleRate, smoothing);
        dryGain.prepare (sampleRate, smoothing);
        prepared = true;
        loadedKey = {};
        loadImpulseIfChanged();
    }

    void resetEffect() override
    {
        conv.reset();
        wetGain.snap (dsp::dbToGain (param (2)));
        dryGain.snap (dsp::dbToGain (param (3)));
    }

    void loadImpulseIfChanged()
    {
        const auto key = juce::String (param (0)) + "|" + juce::String (param (1));
        if (key == loadedKey)
            return;

        loadedKey = key;
        conv.loadImpulseResponse (makeImpulse (param (0), param (1)), sampleRate,
                                  juce::dsp::Convolution::Stereo::yes,
                                  juce::dsp::Convolution::Trim::no,
                                  juce::dsp::Convolution::Normalise::no);
    }

    // impulse() de realtime.js, mais a normalização do ConvolverNode
    // (especificação da Web Audio API, "normalize = true").
    juce::AudioBuffer<float> makeImpulse (float seconds, float damping) const
    {
        const int length = juce::jmax (1, (int) std::round (sampleRate * seconds));
        juce::AudioBuffer<float> ir (2, length);
        juce::Random random;
        double power = 0;

        for (int c = 0; c < 2; ++c)
        {
            auto* d = ir.getWritePointer (c);
            float lp = 0;
            for (int i = 0; i < length; ++i)
            {
                const float env = std::pow (1.0f - (float) i / (float) length, 2.0f + damping * 4.0f);
                lp += (random.nextFloat() * 2.0f - 1.0f - lp) * (1.0f - damping * 0.9f);
                d[i] = lp * env;
                power += (double) d[i] * d[i];
            }
        }

        power = juce::jmax (std::sqrt (power / (2.0 * length)), 0.000125);
        ir.applyGain ((float) (1.0 / power * 0.00125 * 44100.0 / sampleRate));
        return ir;
    }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        wetGain.target = dsp::dbToGain (param (2));
        dryGain.target = dsp::dbToGain (param (3));

        for (int c = 0; c < 2; ++c)
            wetBuffer.copyFrom (c, 0, buffer, c, 0, n);

        juce::dsp::AudioBlock<float> block (wetBuffer.getArrayOfWritePointers(), 2, (size_t) n);
        conv.process (juce::dsp::ProcessContextReplacing<float> (block));

        auto* ch = buffer.getArrayOfWritePointers();
        for (int i = 0; i < n; ++i)
        {
            const float w = wetGain.next();
            const float d = dryGain.next();
            for (int c = 0; c < 2; ++c)
                ch[c][i] = d * ch[c][i] + w * wetBuffer.getSample (c, i);
        }
    }

    juce::dsp::Convolution conv { juce::dsp::Convolution::NonUniform { 512 } };
    juce::AudioBuffer<float> wetBuffer;
    Target wetGain, dryGain;
    juce::String loadedKey;
    int maxBlock = 512;
    bool prepared = false;
};

//==============================================================================
// Compressor no estilo do DynamicsCompressorNode do Chromium: joelho suave,
// detecção estéreo ligada, ganho de compensação automático (fullRangeGain^0.6) e
// 6 ms de antecipação (o sinal sai atrasado e a redução já está pronta quando o
// pico chega). Como no navegador, a compensação automática vale também para o
// Limitador, que por isso pode passar do teto.
struct Dynamics
{
    void prepare (double sampleRate)
    {
        lookahead.setSize (2, juce::jmax (1, (int) std::round (0.006 * sampleRate)));
        reset();
    }

    void reset()
    {
        envelope = 0.0f;
        lookahead.clear();
        lookaheadIndex = 0;
    }

    void process (juce::AudioBuffer<float>& buffer, int n, double sampleRate,
                  float threshold, float ratio, float knee, float attack, float release, float makeupDb)
    {
        ratio = juce::jmax (1.0f, ratio);
        const auto curve = [=] (float x)
        {
            const float over = x - threshold;
            if (2.0f * over < -knee)
                return x;
            if (knee > 0 && 2.0f * std::abs (over) <= knee)
                return x + (1.0f / ratio - 1.0f) * (over + knee / 2) * (over + knee / 2) / (2.0f * knee);
            return threshold + over / ratio;
        };

        const float autoMakeup = -0.6f * curve (0.0f);
        const float attackCoef = std::exp (-1.0f / (juce::jmax (0.0001f, attack) * (float) sampleRate));
        const float releaseCoef = std::exp (-1.0f / (juce::jmax (0.001f, release) * (float) sampleRate));
        auto* l = buffer.getWritePointer (0);
        auto* r = buffer.getWritePointer (1);
        auto* dl = lookahead.getWritePointer (0);
        auto* dr = lookahead.getWritePointer (1);
        const int delay = lookahead.getNumSamples();

        for (int i = 0; i < n; ++i)
        {
            // A redução é calculada com o sinal de agora e aplicada ao de 6 ms atrás.
            const float level = juce::jmax (std::abs (l[i]), std::abs (r[i]), 1.0e-9f);
            const float x = 20.0f * std::log10 (level);
            const float reduction = curve (x) - x;
            const float coef = reduction < envelope ? attackCoef : releaseCoef;
            envelope = reduction + (envelope - reduction) * coef;

            const float g = dsp::dbToGain (envelope + autoMakeup + makeupDb);
            const float delayedL = dl[lookaheadIndex];
            const float delayedR = dr[lookaheadIndex];
            dl[lookaheadIndex] = l[i];
            dr[lookaheadIndex] = r[i];
            lookaheadIndex = (lookaheadIndex + 1) % delay;
            l[i] = delayedL * g;
            r[i] = delayedR * g;
        }
    }

    float envelope = 0.0f;  // redução de ganho atual, em dB (≤ 0)
    juce::AudioBuffer<float> lookahead;
    int lookaheadIndex = 0;
};

class CompressorEffect final : public RealtimeEffect
{
public:
    CompressorEffect()
        : RealtimeEffect ("compressor", { "threshold", "ratio", "knee", "attack", "release", "makeup" }) {}

private:
    void prepareEffect (int) override { dynamics.prepare (sampleRate); }
    void resetEffect() override { dynamics.reset(); }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        dynamics.process (buffer, n, sampleRate, param (0), param (1), param (2),
                          param (3) / 1000.0f, param (4) / 1000.0f, param (5));
    }

    Dynamics dynamics;
};

// Limitador = compressor com razão 20, sem joelho, ataque de 1 ms e liberação de 50 ms.
class LimiterEffect final : public RealtimeEffect
{
public:
    LimiterEffect() : RealtimeEffect ("limiter", { "ceiling", "gain" }) {}

private:
    void prepareEffect (int) override
    {
        inputGain.prepare (sampleRate, smoothing);
        dynamics.prepare (sampleRate);
    }

    void resetEffect() override
    {
        dynamics.reset();
        inputGain.snap (dsp::dbToGain (param (1)));
    }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        inputGain.target = dsp::dbToGain (param (1));
        auto* l = buffer.getWritePointer (0);
        auto* r = buffer.getWritePointer (1);
        for (int i = 0; i < n; ++i)
        {
            const float g = inputGain.next();
            l[i] *= g;
            r[i] *= g;
        }

        dynamics.process (buffer, n, sampleRate, param (0), 20.0f, 0.0f, 0.001f, 0.05f, 0.0f);
    }

    Dynamics dynamics;
    Target inputGain;
};

//==============================================================================
// Distorção: curva tanh(k·x)/tanh(k) com sobreamostragem 4x (WaveShaperNode, oversample '4x').
class DistortionEffect final : public RealtimeEffect
{
public:
    DistortionEffect() : RealtimeEffect ("distortion", { "drive", "output" }) {}

private:
    void prepareEffect (int maxBlockSize) override
    {
        oversampling.initProcessing ((size_t) maxBlockSize);
        output.prepare (sampleRate, smoothing);
    }

    void resetEffect() override
    {
        oversampling.reset();
        output.snap (dsp::dbToGain (param (1)));
    }

    void processEffect (juce::AudioBuffer<float>& buffer, int n) override
    {
        const float k = dsp::dbToGain (param (0));
        const float norm = std::tanh (k);

        juce::dsp::AudioBlock<float> block (buffer.getArrayOfWritePointers(), 2, (size_t) n);
        auto up = oversampling.processSamplesUp (block);
        for (size_t c = 0; c < up.getNumChannels(); ++c)
        {
            auto* d = up.getChannelPointer (c);
            for (size_t i = 0; i < up.getNumSamples(); ++i)
                d[i] = std::tanh (k * juce::jlimit (-1.0f, 1.0f, d[i])) / norm;
        }
        oversampling.processSamplesDown (block);

        output.target = dsp::dbToGain (param (1));
        auto* l = buffer.getWritePointer (0);
        auto* r = buffer.getWritePointer (1);
        for (int i = 0; i < n; ++i)
        {
            const float g = output.next();
            l[i] *= g;
            r[i] *= g;
        }
    }

    juce::dsp::Oversampling<float> oversampling {
        2, 2, juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true
    };
    Target output;
};

} // namespace

//==============================================================================
RealtimeEffect::Ptr RealtimeEffect::create (const juce::String& type)
{
    if (type == "gain")       return new GainEffect();
    if (type == "bassTreble") return new BassTrebleEffect();
    if (type == "filter")     return new FilterEffect();
    if (type == "echo")       return new EchoEffect();
    if (type == "reverb")     return new ReverbEffect();
    if (type == "compressor") return new CompressorEffect();
    if (type == "limiter")    return new LimiterEffect();
    if (type == "distortion") return new DistortionEffect();
    return nullptr;
}

} // namespace raven
