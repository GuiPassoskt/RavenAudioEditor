#pragma once

// Grafo de mixagem do motor nativo, o mesmo do motor Web Audio (src/audio/engine.js):
//
//   faixa: clipe ou sintetizador -> [efeitos da faixa] -> ganho/pan -> Σ ─┐
//   master: Σ faixas -> [efeitos master] -> fader -> saída <──────────────┘
//
// Um MixGraph é imutável: a cada mudança do projeto o thread de mensagens monta
// outro e o troca. O que precisa continuar entre trocas (notas soando, caudas de
// efeitos, ganhos suavizados) mora em TrackState e nos RealtimeEffect, que o
// grafo novo reaproveita.

#include "RealtimeEffects.h"
#include "Synth.h"

#include <atomic>
#include <vector>

namespace raven
{

// Áudio de uma faixa (1 ou 2 canais), enviado pela interface.
struct Clip : public juce::ReferenceCountedObject
{
    using Ptr = juce::ReferenceCountedObjectPtr<Clip>;
    juce::AudioBuffer<float> audio;
};

// Notas de uma faixa MIDI, em segundos relativos ao início da faixa, em ordem de início.
struct NoteList : public juce::ReferenceCountedObject
{
    using Ptr = juce::ReferenceCountedObjectPtr<NoteList>;
    struct Note { double start, end; int pitch, velocity; };
    std::vector<Note> notes;

    static Ptr fromJson (const juce::var& notes);
};

// Estado de uma faixa que sobrevive às trocas de grafo.
struct TrackState : public juce::ReferenceCountedObject
{
    using Ptr = juce::ReferenceCountedObjectPtr<TrackState>;

    void prepare (double sampleRate, int maxBlockSize);

    double sampleRate = 44100;
    juce::AudioBuffer<float> scratch;
    Synth synth;
    dsp::Target gainL, gainR;
    bool snapGains = true;

    // Posição na lista de notas (thread de áudio).
    const NoteList* scheduledNotes = nullptr;
    size_t cursor = 0;
    juce::int64 expectedPosition = -1;
    bool startFromHere = false;  // início da reprodução: notas já soando também tocam

    std::atomic<float> peakL { 0 }, peakR { 0 };  // medidores (pico desde a última leitura)
};

// Fader do master (o estado suavizado sobrevive às trocas de grafo).
struct MasterState
{
    void prepare (double sampleRate) { fader.prepare (sampleRate, 0.01); snap = true; }
    dsp::Target fader;
    bool snap = true;
};

class MixGraph : public juce::ReferenceCountedObject
{
public:
    using Ptr = juce::ReferenceCountedObjectPtr<MixGraph>;

    struct Track
    {
        juce::String id;
        TrackState::Ptr state;
        Clip::Ptr clip;
        NoteList::Ptr notes;
        double offset = 0;  // segundos
        float gainL = 1, gainR = 1;
        int program = 0;
        bool drum = false;
        std::vector<RealtimeEffect::Ptr> effects;
    };

    // De onde vêm os objetos que o grafo usa: ao vivo, o motor reaproveita os que
    // já existem; no render offline, tudo é criado do zero.
    struct Resources
    {
        virtual ~Resources() = default;
        virtual TrackState::Ptr trackState (const juce::String& id) = 0;
        virtual Clip::Ptr clip (const juce::String& id) = 0;
        virtual NoteList::Ptr notes (const juce::String& trackId, const juce::var& track) = 0;
        virtual RealtimeEffect::Ptr effect (const juce::var& state) = 0;
    };

    // project: { tracks: [...], master: { gain, effects } } no formato de engine-native.js.
    static Ptr build (const juce::var& project, double sampleRate, bool applyMaster, Resources& resources);

    // Thread de áudio. Início da reprodução em `position`: zera os efeitos e faz as
    // notas que já estão soando tocarem a partir daqui.
    void locate (juce::int64 position);

    // Thread de áudio. Mixa [position, position + numSamples) em out (2 canais,
    // já zerado). end: fim do trecho tocado (notas e clipes param ali).
    void render (juce::AudioBuffer<float>& out, int numSamples, juce::int64 position, juce::int64 end,
                 MasterState& master);

    double sampleRate = 44100;
    std::vector<Track> tracks;
    std::vector<RealtimeEffect::Ptr> masterEffects;
    float masterGain = 1;

private:
    void scheduleNotes (Track& t, int numSamples, juce::int64 position, juce::int64 end);
};

} // namespace raven
