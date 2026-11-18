#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <map>
#include <memory>

namespace raven
{

// Hospeda as instâncias de plugins abertas pela interface (Fase 1: aplicar um
// plugin num trecho, como o "Efeito → Aplicar" do Audacity).
//
// Tudo aqui roda no thread de mensagens do JUCE, que é onde os formatos VST3,
// LV2 e AU exigem que plugins sejam criados, configurados e destruídos.
class PluginHost
{
public:
    explicit PluginHost (juce::File cacheFile);
    ~PluginHost();

    // Executa um comando do protocolo (Protocol.h). Lança CommandError em erros esperados.
    juce::var handle (const juce::String& cmd, const juce::var& message);

    // Instancia um plugin da lista (thread de mensagens). nullptr e error preenchido se falhar.
    std::unique_ptr<juce::AudioPluginInstance> createPlugin (const juce::String& pluginId, double sampleRate,
                                                             int maxBlockSize, juce::String& error);

private:
    class Instance;

    juce::var ping() const;
    juce::var listPlugins();
    juce::var createInstance (const juce::var& message);
    juce::var setParam (const juce::var& message);
    juce::var openEditor (const juce::var& message);
    juce::var closeEditor (const juce::var& message);
    juce::var process (const juce::var& message);
    juce::var destroyInstance (const juce::var& message);

    Instance& getInstance (const juce::var& message);
    void reloadKnownPlugins();
    void onParameterChanged (int instanceId, int index, float value);
    void onEditorClosed (int instanceId);

    juce::File cacheFile;
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPlugins;
    std::map<int, std::unique_ptr<Instance>> instances;
    int nextInstanceId = 1;

    JUCE_DECLARE_NON_COPYABLE (PluginHost)
};

// Parâmetros de um plugin para a interface (só os automatizáveis).
juce::var describeParameter (const juce::AudioProcessorParameter& param);
juce::var describeParameters (juce::AudioPluginInstance& plugin);

// Tenta fazer o barramento principal do plugin ter numChannels de entrada e de saída.
bool configureLayout (juce::AudioPluginInstance& plugin, int numChannels);

} // namespace raven
