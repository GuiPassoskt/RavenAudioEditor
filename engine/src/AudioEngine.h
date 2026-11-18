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

#include <juce_audio_devices/juce_audio_devices.h>

#include <map>

namespace raven
{

class AudioEngine final : private juce::AudioIODeviceCallback,
                          private juce::Timer
{
public:
    explicit AudioEngine (juce::File settingsFile);
    ~AudioEngine() override;

    // Comandos audio.*, project.*, clips.*, transport.*, preview.*, synth.*, render.*, capture.*.
    static bool handles (const juce::String& cmd);
    juce::var handle (const juce::String& cmd, const juce::var& message);

    juce::var status() const;

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
    juce::var renderOffline (const juce::var& message);
    juce::var startCapture (const juce::var& message);
    juce::var readCapture (const juce::var& message);
    juce::var stopCapture();

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
    std::vector<juce::ReferenceCountedObjectPtr<juce::ReferenceCountedObject>> releasePool;

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
