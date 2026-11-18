#pragma once

#include "Dsp.h"

#include <array>

namespace raven
{

// Sintetizador das faixas MIDI: o mesmo de src/audio/synth.js (osciladores com
// envelope ADSR por família General MIDI e bateria no canal 10), polifônico.
// Tudo roda no thread de áudio; noteOn agenda a nota dentro do próximo render().
class Synth
{
public:
    void prepare (double sampleRate);

    // offset: amostras a partir do início do próximo bloco; length: duração em
    // amostras até o "note off" (a bateria ignora).
    void noteOn (int pitch, int velocity, int program, bool drum, int offset, juce::int64 length);
    void allNotesOff();

    // Soma a saída (mono, nos dois canais) em out[0..numSamples).
    void render (juce::AudioBuffer<float>& out, int numSamples);

private:
    struct Voice
    {
        bool active = false;
        bool drum = false;
        int family = 0;
        int pitch = 60;
        float level = 0;             // pico do envelope (velocidade)
        double f0 = 440;
        juce::int64 age = 0;         // amostras desde o início (negativo = ainda não começou)
        juce::int64 releaseAt = 0;   // amostra do "note off"
        juce::int64 stopAt = 0;      // amostra em que a voz termina
        std::array<double, 3> phase {};
        float releaseFrom = 0;       // valor do envelope no "note off"
        dsp::Biquad filter;
        juce::uint32 noiseSeed = 1;
    };

    float renderTonal (Voice& v);
    float renderDrum (Voice& v);
    static float noise (Voice& v);

    double sampleRate = 44100;
    std::array<Voice, 96> voices;
};

} // namespace raven
