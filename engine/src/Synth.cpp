#include "Synth.h"

namespace raven
{

using dsp::Wave;

namespace
{

struct Osc
{
    Wave wave;
    double mult;
    float gain;
    double cents;
};

struct Family
{
    std::array<Osc, 3> osc;
    int numOsc;
    double a, d, s, r;
    bool decayByPitch = false;
    bool hasFilter = false;
    double peak = 0, sustainHz = 0, time = 0;  // filtro: [pico, sustentação, constante de tempo]
};

// FAMILIES de synth.js: [tipo, multiplicador, ganho, cents] + ADSR (+ filtro).
const std::array<Family, 16> families {{
    { {{ { Wave::triangle, 1, 0.7f, 0 }, { Wave::sine, 2, 0.25f, 0 }, { Wave::sine, 3, 0.08f, 0 } }}, 3, 0.004, 1.6, 0, 0.25, true },
    { {{ { Wave::sine, 1, 0.7f, 0 }, { Wave::sine, 3.98, 0.25f, 0 } }}, 2, 0.002, 1.2, 0, 0.4 },
    { {{ { Wave::sine, 1, 0.5f, 0 }, { Wave::sine, 2, 0.3f, 0 }, { Wave::square, 4, 0.06f, 0 } }}, 3, 0.01, 0.05, 1, 0.06 },
    { {{ { Wave::sawtooth, 1, 0.5f, 0 } }}, 1, 0.003, 1.1, 0.05, 0.15, false, true, 5000, 900, 0.4 },
    { {{ { Wave::sawtooth, 1, 0.45f, 0 }, { Wave::sine, 1, 0.5f, 0 } }}, 2, 0.005, 0.8, 0.35, 0.08, false, true, 1400, 500, 0.3 },
    { {{ { Wave::sawtooth, 1, 0.4f, -6 }, { Wave::sawtooth, 1, 0.4f, 6 } }}, 2, 0.08, 0.2, 0.85, 0.25, false, true, 3200, 3200, 1 },
    { {{ { Wave::sawtooth, 1, 0.3f, -9 }, { Wave::sawtooth, 1, 0.3f, 9 }, { Wave::sawtooth, 2, 0.1f, 0 } }}, 3, 0.15, 0.2, 0.9, 0.4, false, true, 2600, 2600, 1 },
    { {{ { Wave::sawtooth, 1, 0.5f, 0 } }}, 1, 0.03, 0.15, 0.8, 0.1, false, true, 3500, 1200, 0.15 },
    { {{ { Wave::square, 1, 0.35f, 0 }, { Wave::sawtooth, 1, 0.15f, 0 } }}, 2, 0.02, 0.1, 0.85, 0.08, false, true, 2800, 2800, 1 },
    { {{ { Wave::sine, 1, 0.7f, 0 }, { Wave::triangle, 2, 0.1f, 0 } }}, 2, 0.04, 0.1, 0.9, 0.12 },
    { {{ { Wave::square, 1, 0.35f, 0 }, { Wave::sawtooth, 1, 0.15f, 8 } }}, 2, 0.005, 0.1, 0.8, 0.08 },
    { {{ { Wave::sawtooth, 1, 0.25f, -12 }, { Wave::sawtooth, 1, 0.25f, 12 }, { Wave::triangle, 0.5, 0.2f, 0 } }}, 3, 0.4, 0.5, 0.8, 0.8, false, true, 1800, 1800, 1 },
    { {{ { Wave::sawtooth, 1, 0.3f, 0 }, { Wave::square, 1.5, 0.15f, 0 } }}, 2, 0.2, 0.6, 0.6, 0.6, false, true, 2500, 800, 0.5 },
    { {{ { Wave::triangle, 1, 0.5f, 0 }, { Wave::sine, 2.01, 0.3f, 0 } }}, 2, 0.003, 0.9, 0.1, 0.2 },
    { {{ { Wave::sine, 1, 0.8f, 0 } }}, 1, 0.001, 0.35, 0, 0.1 },
    { {{ { Wave::sawtooth, 1, 0.3f, 0 }, { Wave::square, 0.5, 0.3f, 0 } }}, 2, 0.01, 0.4, 0.4, 0.3, false, true, 2000, 400, 0.4 },
}};

enum DrumKind { kick, hat, cymbal, snare, tom };

DrumKind drumKind (int pitch)
{
    if (pitch == 35 || pitch == 36)                 return kick;
    if (pitch == 42 || pitch == 44 || pitch == 46)  return hat;
    if (pitch >= 37 && pitch <= 40)                 return snare;
    for (int p : { 49, 51, 52, 53, 55, 57, 59 })
        if (pitch == p)
            return cymbal;
    return tom;
}

// exponentialRampToValueAtTime de v0 até v1 em T segundos.
double expRamp (double v0, double v1, double T, double t)
{
    return t >= T ? v1 : v0 * std::pow (v1 / v0, t / T);
}

double drumLength (int pitch)
{
    switch (drumKind (pitch))
    {
        case kick:   return 0.4;
        case cymbal: return 1.2 + 0.05;
        case hat:    return (pitch == 46 ? 0.35 : 0.06) + 0.05;
        case snare:  return 0.18 + 0.05;
        case tom:    return 0.45;
    }
    return 0.45;
}

const Family& familyOf (int index) { return families[(size_t) juce::jlimit (0, 15, index)]; }

double decayOf (const Family& fam, int pitch)
{
    // Notas graves do piano decaem mais devagar.
    return fam.decayByPitch ? fam.d * std::pow (2.0, (60 - pitch) / 24.0) : fam.d;
}

// Envelope até o "note off": rampa linear até o pico e decaimento exponencial
// até o nível de sustentação (setTargetAtTime com constante decay / 3).
double attackDecay (const Family& fam, int pitch, double level, double t)
{
    if (t < fam.a)
        return level * t / fam.a;
    const double sustain = level * fam.s;
    return sustain + (level - sustain) * std::exp (-(t - fam.a) / (decayOf (fam, pitch) / 3.0));
}

} // namespace

//==============================================================================
void Synth::prepare (double newSampleRate)
{
    sampleRate = newSampleRate;
    allNotesOff();
}

void Synth::allNotesOff()
{
    for (auto& v : voices)
        v.active = false;
}

void Synth::noteOn (int pitch, int velocity, int program, bool drum, int offset, juce::int64 length)
{
    // Uma voz livre; se não houver, rouba a mais antiga.
    Voice* voice = nullptr;
    for (auto& v : voices)
        if (! v.active) { voice = &v; break; }

    if (voice == nullptr)
    {
        voice = &voices[0];
        for (auto& v : voices)
            if (v.age > voice->age)
                voice = &v;
    }

    auto& v = *voice;
    v = Voice {};
    v.active = true;
    v.drum = drum;
    v.pitch = pitch;
    v.family = program / 8;
    v.level = (float) (std::pow (juce::jmax (1, velocity) / 127.0, 1.5) * 0.3);
    v.f0 = 440.0 * std::pow (2.0, (pitch - 69) / 12.0);
    v.age = -offset;
    v.noiseSeed = (juce::uint32) (pitch * 2654435761u + (juce::uint32) offset + 1u);

    if (drum)
    {
        v.stopAt = (juce::int64) (drumLength (pitch) * sampleRate);
        const auto kind = drumKind (pitch);
        if (kind == snare)
            v.filter.set (dsp::Biquad::Type::bandpass, 1800, 0.7, 0, sampleRate);
        else if (kind == hat || kind == cymbal)
            v.filter.set (dsp::Biquad::Type::highpass, 7000, 0.5, 0, sampleRate);
        return;
    }

    const auto& fam = familyOf (v.family);
    v.releaseAt = juce::jmax<juce::int64> (1, length);
    v.releaseFrom = (float) attackDecay (fam, pitch, v.level, (double) v.releaseAt / sampleRate);
    v.stopAt = v.releaseAt + (juce::int64) (fam.r * 1.5 * sampleRate);
}

void Synth::release (Voice& v, juce::int64 at)
{
    if (! v.active || v.drum || v.releaseAt <= at)
        return;

    const auto& fam = familyOf (v.family);
    v.releaseAt = juce::jmax<juce::int64> (1, at);
    v.releaseFrom = (float) attackDecay (fam, v.pitch, v.level, (double) v.releaseAt / sampleRate);
    v.stopAt = v.releaseAt + (juce::int64) (fam.r * 1.5 * sampleRate);
}

void Synth::noteOff (int pitch, int offset)
{
    for (auto& v : voices)
        if (v.pitch == pitch)
            release (v, v.age + offset);
}

void Synth::releaseAll()
{
    for (auto& v : voices)
        release (v, v.age);
}

float Synth::noise (Voice& v)
{
    v.noiseSeed ^= v.noiseSeed << 13;
    v.noiseSeed ^= v.noiseSeed >> 17;
    v.noiseSeed ^= v.noiseSeed << 5;
    return (float) v.noiseSeed / 2147483648.0f - 1.0f;
}

float Synth::renderTonal (Voice& v)
{
    const auto& fam = familyOf (v.family);
    const double t = (double) v.age / sampleRate;

    double env;
    if (v.age < v.releaseAt)
        env = attackDecay (fam, v.pitch, v.level, t);
    else
        env = v.releaseFrom * std::exp (-(t - (double) v.releaseAt / sampleRate) / (fam.r / 4.0));

    float sum = 0;
    for (int k = 0; k < fam.numOsc; ++k)
    {
        const auto& o = fam.osc[(size_t) k];
        const double freq = v.f0 * o.mult * std::pow (2.0, o.cents / 1200.0);
        const double dt = freq / sampleRate;
        sum += o.gain * dsp::oscillator (o.wave, v.phase[(size_t) k], dt);
        v.phase[(size_t) k] = std::fmod (v.phase[(size_t) k] + dt, 1.0);
    }

    if (fam.hasFilter)
    {
        // Corte começa alto e desce até a sustentação (setTargetAtTime em synth.js).
        if (v.age % 16 == 0)
        {
            const double start = juce::jmin (fam.peak + v.f0 * 2.0, 18000.0);
            const double target = juce::jmin (fam.sustainHz + v.f0, 18000.0);
            const double freq = t < fam.a ? start : target + (start - target) * std::exp (-(t - fam.a) / fam.time);
            v.filter.set (dsp::Biquad::Type::lowpass, freq, 0.8, 0, sampleRate);
        }
        sum = v.filter.process (sum, 0);
    }

    return (float) (sum * env);
}

float Synth::renderDrum (Voice& v)
{
    const double t = (double) v.age / sampleRate;
    const double level = v.level * 0.9;
    const auto kind = drumKind (v.pitch);

    if (kind == kick || kind == tom)
    {
        // Senoide com queda de afinação.
        double freq, gain;
        if (kind == kick)
        {
            freq = expRamp (150, 45, 0.12, t);
            gain = expRamp (level, 0.001, 0.35, t);
        }
        else
        {
            const double base = 60.0 + (v.pitch - 41) * 12.0;
            freq = expRamp (juce::jmax (20.0, base * 1.6), juce::jmax (30.0, base), 0.15, t);
            gain = expRamp (level * 0.8, 0.001, 0.4, t);
        }
        const float s = (float) std::sin (dsp::twoPi * v.phase[0]);
        v.phase[0] = std::fmod (v.phase[0] + freq / sampleRate, 1.0);
        return (float) (s * gain);
    }

    // Prato, chimbal e caixa: ruído filtrado.
    const double len = kind == cymbal ? 1.2 : v.pitch == 46 ? 0.35 : kind == snare ? 0.18 : 0.06;
    const double gain = expRamp (level * (kind == snare ? 0.9 : 0.45), 0.001, len, t);
    float out = (float) (v.filter.process (noise (v), 0) * gain);

    if (kind == snare && t < 0.12)
    {
        out += (float) (dsp::oscillator (Wave::triangle, v.phase[0], 190.0 / sampleRate)
                        * expRamp (level * 0.5, 0.001, 0.1, t));
        v.phase[0] = std::fmod (v.phase[0] + 190.0 / sampleRate, 1.0);
    }

    return out;
}

void Synth::render (juce::AudioBuffer<float>& out, int numSamples)
{
    auto* l = out.getWritePointer (0);
    auto* r = out.getWritePointer (1);

    for (auto& v : voices)
    {
        if (! v.active)
            continue;

        for (int i = 0; i < numSamples; ++i)
        {
            if (v.age >= 0)
            {
                const float s = v.drum ? renderDrum (v) : renderTonal (v);
                l[i] += s;
                r[i] += s;
            }

            if (++v.age >= v.stopAt)
            {
                v.active = false;
                break;
            }
        }
    }
}

} // namespace raven
