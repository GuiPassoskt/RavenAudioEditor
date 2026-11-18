#pragma once

#include "PluginWindow.h"
#include "RealtimeEffects.h"

#include <map>

namespace raven
{

// Plugin VST3/LV2 numa cadeia de efeitos em tempo real (Fase 3 de
// docs/INTEGRACAO-PLUGINS-NATIVOS.md). Para o grafo é só mais um RealtimeEffect.
//
// O estado do plugin (getStateInformation, em base64) mora no projeto. Quando o
// usuário mexe no plugin (janela nativa ou parâmetros), o efeito avisa a interface
// com "chain.pluginState" depois de 400 ms sem mudanças; a interface guarda o
// estado no histórico, e o desfazer o devolve com applyState().
class PluginEffect final : public RealtimeEffect,
                           private juce::AudioProcessorListener,
                           private juce::AsyncUpdater,
                           private juce::Timer
{
public:
    using Ptr = juce::ReferenceCountedObjectPtr<PluginEffect>;

    // offline: instância de render offline (sem janela, sem eventos para a interface).
    PluginEffect (juce::String uid, juce::String pluginId, std::unique_ptr<juce::AudioPluginInstance> plugin, bool offline);
    ~PluginEffect() override;

    const juce::String uid, pluginId;

    // Thread de mensagens.
    void applyState (const juce::String& base64);
    void restoreInitialState() { applyState (initialState); }
    juce::String currentState();
    juce::var info();
    void setParameter (int index, float value);
    void openEditor();
    void closeEditor();

    int getLatencySamples() const override { return plugin->getLatencySamples(); }

    juce::int64 appliedVersion = 0;         // versão do estado vinda da interface já aplicada
    std::function<void()> onLatencyChanged;  // o motor remonta o grafo (compensação de latência)

private:
    void prepareEffect (int maxBlockSize) override;
    void resetEffect() override;
    void processEffect (juce::AudioBuffer<float>& buffer, int numSamples) override;

    // Podem vir do thread de áudio do plugin: só anotam e agendam.
    void audioProcessorParameterChanged (juce::AudioProcessor*, int index, float value) override;
    void audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails&) override;

    void handleAsyncUpdate() override;  // thread de mensagens
    void timerCallback() override;      // 400 ms sem mudanças: avisa o estado novo
    void emitStateIfChanged();

    std::unique_ptr<juce::AudioPluginInstance> plugin;
    std::unique_ptr<PluginWindow> window;
    const bool offline;
    bool stereo = true;
    juce::AudioBuffer<float> io;
    juce::MidiBuffer midi;
    juce::String initialState, lastState;
    int lastLatency = 0;

    juce::SpinLock pendingLock;
    std::map<int, float> pendingParams;
    std::atomic<bool> dirty { false };
};

} // namespace raven
