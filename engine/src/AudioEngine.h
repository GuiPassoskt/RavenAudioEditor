#pragma once

// Motor de reprodução, gravação e render do Raven (Fase 2 de
// docs/INTEGRACAO-PLUGINS-NATIVOS.md). Substitui o motor Web Audio
// (src/audio/engine.js) no app desktop, com a mesma interface vista pela
// interface (src/audio/engine-native.js).
//
// O projeto é mixado na taxa do projeto e convertido para a taxa do dispositivo
// (ResamplingAudioSource), porque o modo compartilhado do Windows só toca na
// taxa do mixer do sistema.

#include "MixGraph.h"
#include "PluginEffect.h"
#include "PluginHost.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <list>
#include <map>
#include <thread>

namespace raven
{

class AudioEngine final : private juce::AudioIODeviceCallback,
                          private juce::MidiInputCallback,
                          private juce::Timer
{
public:
    AudioEngine (juce::File settingsFile, PluginHost& plugins);
    ~AudioEngine() override;

    // Comandos audio.*, project.*, clips.*, transport.*, preview.*, synth.*, render.*, capture.*.
    static bool handles (const juce::String& cmd);
    juce::var handle (const juce::String& cmd, const juce::var& message);

    juce::var status() const;

    // render.offline roda num thread próprio (exportar sem travar o motor): a
    // resposta ao pedido `id` sai quando terminar, com eventos render.progress
    // no caminho. render.cancel { job } interrompe.
    void renderOffline (const juce::var& id, const juce::var& message);

private:
    class MixSource;
    class LiveResources;
    class OfflineResources;

    // Comandos (thread de mensagens).
    juce::var devices();
    juce::var setDevice (const juce::var& message);
    juce::var syncProject (const juce::var& message);
    juce::var setRate (const juce::var& message);
    juce::var loadClip (const juce::var& message);
    juce::var releaseClips (const juce::var& message);
    juce::var play (const juce::var& message);
    juce::var stop();
    juce::var playPreview (const juce::var& message);
    juce::var stopPreview();
    juce::var audition (const juce::var& message);
    juce::var cancelRender (const juce::var& message);
    juce::var startCapture (const juce::var& message);
    juce::var readCapture (const juce::var& message);
    juce::var stopCapture();
    juce::var pluginInfo (const juce::var& message);
    juce::var setPluginParam (const juce::var& message);
    juce::var openPluginEditor (const juce::var& message);
    juce::var closePluginEditor (const juce::var& message);
    juce::var midiDevices();
    juce::var setMidiInput (const juce::var& message);
    juce::var startMidiRecording();
    juce::var readMidiRecording();
    juce::var stopMidiRecording();
    juce::var simulateMidi (const juce::var& message);

    // Entrada MIDI (thread do driver MIDI): só enfileira no coletor.
    void handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message) override;

    PluginEffect& livePlugin (const juce::var& message);
    void rebuildGraph();

    void setProjectRate (double rate);
    void publishGraph (MixGraph::Ptr newGraph);
    void keepUntilUnused (juce::ReferenceCountedObject* object);
    void saveSettings();

    // Thread de áudio.
    void audioDeviceIOCallbackWithContext (const float* const* inputs, int numInputs,
                                           float* const* outputs, int numOutputs, int numSamples,
                                           const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void renderProject (juce::AudioBuffer<float>& mix, int numSamples);

    // Medidores e posição para a interface, ~30 vezes por segundo.
    void timerCallback() override;

    juce::File settingsFile;
    PluginHost& plugins;
    juce::AudioDeviceManager deviceManager;
    juce::String deviceError;
    std::unique_ptr<MixSource> mixSource;
    std::unique_ptr<juce::ResamplingAudioSource> resampler;
    juce::AudioBuffer<float> deviceBuffer;
    std::atomic<double> projectRate { 44100.0 };
    std::atomic<double> deviceRate { 48000.0 };
    std::atomic<double> outputLatency { 0.0 };  // segundos

    // Recursos ao vivo (thread de mensagens).
    std::map<juce::String, Clip::Ptr> clips;
    std::map<juce::String, TrackState::Ptr> trackStates;
    std::map<juce::String, RealtimeEffect::Ptr> effects;
    std::map<juce::String, std::pair<juce::String, NoteList::Ptr>> notesCache;  // trackId -> (versão, notas)
    std::map<juce::String, juce::String> failedPlugins;  // uid -> pluginId que não carregou (não tenta de novo)
    juce::var lastProject;                               // último project.sync (para remontar o grafo)
    std::vector<juce::ReferenceCountedObjectPtr<juce::ReferenceCountedObject>> releasePool;

    // Renders em segundo plano (a lista só é mexida no thread de mensagens).
    struct RenderJob
    {
        juce::String name;
        std::atomic<bool> cancel { false };
        std::atomic<bool> finished { false };
        std::thread thread;
    };
    std::list<std::unique_ptr<RenderJob>> renderJobs;
    void joinFinishedRenders();

    // Grafo atual: o thread de mensagens troca, o de áudio copia com try-lock.
    juce::SpinLock graphLock;
    MixGraph::Ptr graph;
    MixGraph::Ptr audioGraph;
    MasterState masterState;
    double masterStateRate = 0;

    // Transporte.
    std::atomic<bool> playing { false };
    std::atomic<bool> ended { false };
    std::atomic<juce::uint32> playSequence { 0 };
    juce::uint32 audioPlaySequence = 0;
    std::atomic<juce::int64> playStart { 0 }, playEnd { 0 }, position { 0 };
    bool wasActive = false;
    bool audioWasPlaying = false;  // thread de áudio: detecta o stop para soltar as notas

    // Prévia de efeito e notas avulsas do piano roll.
    Clip::Ptr previewClip;
    Clip::Ptr audioPreview;
    std::atomic<juce::uint32> previewSequence { 0 };
    juce::uint32 audioPreviewSequence = 0;
    int previewPosition = 0;

    struct AuditionNote { int pitch, velocity, program; bool drum; };
    juce::AbstractFifo auditionFifo { 64 };
    std::array<AuditionNote, 64> auditionNotes {};
    Synth auditionSynth;
    double auditionRate = 0;

    // Entrada MIDI (Fase 4): o driver MIDI (e midi.simulate) enfileiram cada
    // mensagem com o horário de chegada; o thread de áudio a posiciona no bloco pelo
    // atraso. (O MidiMessageCollector do JUCE descartava mensagens que chegavam
    // entre a leitura do relógio e a entrada na fila.) Durante a gravação, os
    // eventos vão para outro FIFO, lido pela interface.
    struct IncomingMidi { juce::uint8 status, data1, data2; double time; };
    void queueMidi (const juce::MidiMessage& message);
    std::unique_ptr<juce::MidiInput> midiInput;
    juce::String midiInputId;
    juce::SpinLock midiQueueLock;  // só entre produtores (driver MIDI e thread de mensagens)
    juce::AbstractFifo midiQueueFifo { 1024 };
    std::array<IncomingMidi, 1024> midiQueue {};
    juce::MidiBuffer midiBlock;
    std::atomic<bool> midiRecording { false };
    std::atomic<bool> midiActivity { false };
    struct RecordedMidi { juce::int64 sample; juce::uint8 status, data1, data2; };
    juce::AbstractFifo midiRecordFifo { 8192 };
    std::vector<RecordedMidi> midiRecordQueue = std::vector<RecordedMidi> (8192);

    // Medidores (pico desde a última leitura).
    std::atomic<float> masterPeakL { 0 }, masterPeakR { 0 }, inputPeak { 0 };

    // Gravação: o thread de áudio enche um FIFO na taxa do dispositivo; a
    // interface lê aos poucos (capture.read), já convertido para a taxa do projeto.
    std::atomic<bool> capturing { false };
    juce::AbstractFifo captureFifo { 1 };
    juce::AudioBuffer<float> captureRing;
    std::array<std::vector<float>, 2> captureCarry;
    std::array<juce::LagrangeInterpolator, 2> captureInterpolators;

    JUCE_DECLARE_NON_COPYABLE (AudioEngine)
};

} // namespace raven
