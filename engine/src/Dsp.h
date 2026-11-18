#pragma once

// Peças de DSP do motor que imitam os nós da Web Audio API, para o motor
// nativo soar como o motor do navegador (src/audio/realtime.js e synth.js).

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace raven::dsp
{

constexpr double twoPi = juce::MathConstants<double>::twoPi;

inline float dbToGain (double db) { return (float) std::pow (10.0, db / 20.0); }

//==============================================================================
// BiquadFilterNode, com as fórmulas da especificação da Web Audio API
// (https://www.w3.org/TR/webaudio/#filters-characteristics). Atenção: em
// lowpass/highpass o Q é em dB, como no navegador.
struct Biquad
{
    enum class Type { lowpass, highpass, bandpass, lowshelf, highshelf, allpass };

    void set (Type type, double freq, double q, double gainDb, double sampleRate)
    {
        const double nyquist = sampleRate * 0.5;
        const double w0 = twoPi * juce::jlimit (1.0, nyquist * 0.9999, freq) / sampleRate;
        const double cosw = std::cos (w0);
        const double sinw = std::sin (w0);
        const double A = std::pow (10.0, gainDb / 40.0);
        const double alphaQ = sinw / (2.0 * q);
        const double alphaQdB = sinw / (2.0 * std::pow (10.0, q / 20.0));
        const double alphaS = sinw / 2.0 * std::sqrt (2.0);  // S = 1
        const double sqA = 2.0 * alphaS * std::sqrt (A);

        double nb0 = 1, nb1 = 0, nb2 = 0, na0 = 1, na1 = 0, na2 = 0;

        switch (type)
        {
            case Type::lowpass:
                nb0 = (1 - cosw) / 2; nb1 = 1 - cosw; nb2 = (1 - cosw) / 2;
                na0 = 1 + alphaQdB; na1 = -2 * cosw; na2 = 1 - alphaQdB;
                break;
            case Type::highpass:
                nb0 = (1 + cosw) / 2; nb1 = -(1 + cosw); nb2 = (1 + cosw) / 2;
                na0 = 1 + alphaQdB; na1 = -2 * cosw; na2 = 1 - alphaQdB;
                break;
            case Type::bandpass:
                nb0 = alphaQ; nb1 = 0; nb2 = -alphaQ;
                na0 = 1 + alphaQ; na1 = -2 * cosw; na2 = 1 - alphaQ;
                break;
            case Type::lowshelf:
                nb0 = A * ((A + 1) - (A - 1) * cosw + sqA);
                nb1 = 2 * A * ((A - 1) - (A + 1) * cosw);
                nb2 = A * ((A + 1) - (A - 1) * cosw - sqA);
                na0 = (A + 1) + (A - 1) * cosw + sqA;
                na1 = -2 * ((A - 1) + (A + 1) * cosw);
                na2 = (A + 1) + (A - 1) * cosw - sqA;
                break;
            case Type::highshelf:
                nb0 = A * ((A + 1) + (A - 1) * cosw + sqA);
                nb1 = -2 * A * ((A - 1) + (A + 1) * cosw);
                nb2 = A * ((A + 1) + (A - 1) * cosw - sqA);
                na0 = (A + 1) - (A - 1) * cosw + sqA;
                na1 = 2 * ((A - 1) - (A + 1) * cosw);
                na2 = (A + 1) - (A - 1) * cosw - sqA;
                break;
            case Type::allpass:
                nb0 = 1 - alphaQ; nb1 = -2 * cosw; nb2 = 1 + alphaQ;
                na0 = 1 + alphaQ; na1 = -2 * cosw; na2 = 1 - alphaQ;
                break;
        }

        b0 = nb0 / na0; b1 = nb1 / na0; b2 = nb2 / na0;
        a1 = na1 / na0; a2 = na2 / na0;
    }

    float process (float x, int ch) noexcept
    {
        const double y = b0 * x + z1[ch];
        z1[ch] = b1 * x - a1 * y + z2[ch];
        z2[ch] = b2 * x - a2 * y;
        return (float) y;
    }

    void reset() noexcept { z1[0] = z1[1] = z2[0] = z2[1] = 0; }

    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double z1[2] {}, z2[2] {};
};

//==============================================================================
// AudioParam.setTargetAtTime: aproximação exponencial com constante de tempo tau.
struct Target
{
    void prepare (double sampleRate, double tauSeconds)
    {
        coef = (float) (1.0 - std::exp (-1.0 / (tauSeconds * sampleRate)));
    }

    void snap (float v) noexcept { value = target = v; }
    float next() noexcept { return value += (target - value) * coef; }
    bool settled() const noexcept { return std::abs (target - value) < 1.0e-6f; }

    float value = 0, target = 0, coef = 1;
};

//==============================================================================
// OscillatorNode: senoide, quadrada, dente de serra e triângulo. Quadrada e dente
// de serra usam PolyBLEP para não gerar aliasing (o navegador usa tabelas
// limitadas em banda).
enum class Wave { sine, square, sawtooth, triangle };

inline double polyBlep (double t, double dt) noexcept
{
    if (t < dt)       { t /= dt;             return t + t - t * t - 1.0; }
    if (t > 1.0 - dt) { t = (t - 1.0) / dt;  return t * t + t + t + 1.0; }
    return 0.0;
}

// O navegador normaliza as ondas limitadas em banda pelo pico, que inclui o
// overshoot de Gibbs (~18% em quadrada e dente de serra): o mesmo nível aqui.
constexpr double gibbsNormalization = 0.848;

// phase em [0, 1); dt = frequência / taxa.
inline float oscillator (Wave wave, double phase, double dt) noexcept
{
    switch (wave)
    {
        case Wave::sine:     return (float) std::sin (twoPi * phase);
        case Wave::sawtooth: return (float) (gibbsNormalization * (2.0 * phase - 1.0 - polyBlep (phase, dt)));
        case Wave::square:
        {
            const double v = phase < 0.5 ? 1.0 : -1.0;
            return (float) (gibbsNormalization * (v + polyBlep (phase, dt) - polyBlep (std::fmod (phase + 0.5, 1.0), dt)));
        }
        case Wave::triangle: return (float) (phase < 0.5 ? 4.0 * phase - 1.0 : 3.0 - 4.0 * phase);
    }
    return 0.0f;
}

} // namespace raven::dsp
