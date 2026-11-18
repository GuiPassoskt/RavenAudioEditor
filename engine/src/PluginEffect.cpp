#include "PluginEffect.h"

#include "PluginHost.h"
#include "Protocol.h"

namespace raven
{

static constexpr int stateDebounceMs = 400;
static constexpr int maxTextLength = 64;

PluginEffect::PluginEffect (juce::String uidIn, juce::String pluginIdIn,
                            std::unique_ptr<juce::AudioPluginInstance> pluginIn, bool isOffline)
    : RealtimeEffect ("plugin", {}),
      uid (std::move (uidIn)),
      pluginId (std::move (pluginIdIn)),
      plugin (std::move (pluginIn)),
      offline (isOffline)
{
    // Estado de fábrica: é para onde o desfazer volta quando o projeto não tem estado guardado.
    initialState = lastState = currentState();
    lastLatency = plugin->getLatencySamples();

    if (! offline)
        plugin->addListener (this);
}

PluginEffect::~PluginEffect()
{
    stopTimer();
    cancelPendingUpdate();
    window.reset();  // o editor precisa sumir antes do plugin

    if (! offline)
        plugin->removeListener (this);

    plugin->releaseResources();
}

//==============================================================================
void PluginEffect::prepareEffect (int maxBlockSize)
{
    // Estéreo de preferência; plugin só mono recebe (L + R) / 2 e devolve nos dois canais.
    stereo = configureLayout (*plugin, 2);
    if (! stereo && ! configureLayout (*plugin, 1))
        stereo = plugin->getMainBusNumInputChannels() >= 2;

    plugin->setNonRealtime (offline);
    plugin->prepareToPlay (sampleRate, maxBlockSize);
    io.setSize (juce::jmax (plugin->getTotalNumInputChannels(), plugin->getTotalNumOutputChannels(), 2), maxBlockSize);
    lastLatency = plugin->getLatencySamples();
}

void PluginEffect::resetEffect()
{
    plugin->reset();
}

void PluginEffect::processEffect (juce::AudioBuffer<float>& buffer, int numSamples)
{
    // Nunca espera no thread de áudio: se o plugin estiver ocupado (troca de
    // estado), o som passa sem efeito neste bloco.
    const juce::ScopedTryLock lock (plugin->getCallbackLock());
    if (! lock.isLocked() || plugin->isSuspended())
        return;

    io.setSize (io.getNumChannels(), numSamples, false, false, true);
    io.clear();

    if (stereo)
    {
        io.copyFrom (0, 0, buffer, 0, 0, numSamples);
        io.copyFrom (1, 0, buffer, 1, 0, numSamples);
    }
    else
    {
        io.copyFrom (0, 0, buffer, 0, 0, numSamples);
        io.addFrom (0, 0, buffer, 1, 0, numSamples);
        io.applyGain (0, 0, numSamples, 0.5f);
    }

    midi.clear();
    plugin->processBlock (io, midi);

    const int outputs = plugin->getMainBusNumOutputChannels();
    buffer.copyFrom (0, 0, io, 0, 0, numSamples);
    buffer.copyFrom (1, 0, io, outputs >= 2 ? 1 : 0, 0, numSamples);
}

//==============================================================================
juce::String PluginEffect::currentState()
{
    juce::MemoryBlock data;
    plugin->getStateInformation (data);
    return data.toBase64Encoding();
}

void PluginEffect::applyState (const juce::String& base64)
{
    juce::MemoryBlock data;
    if (base64.isEmpty() || ! data.fromBase64Encoding (base64))
        return;

    plugin->suspendProcessing (true);
    plugin->setStateInformation (data.getData(), (int) data.getSize());
    plugin->suspendProcessing (false);

    // O que o plugin devolve agora é a referência: as notificações que o próprio
    // setStateInformation dispara não viram um "ajuste" novo no histórico.
    lastState = currentState();
    dirty = false;
    stopTimer();
}

juce::var PluginEffect::info()
{
    return juce::var (object ({ { "name", plugin->getName() },
                                { "latency", plugin->getLatencySamples() },
                                { "hasEditor", plugin->hasEditor() },
                                { "editorOpen", window != nullptr },
                                { "params", describeParameters (*plugin) } }).get());
}

void PluginEffect::setParameter (int index, float value)
{
    auto* param = plugin->getParameters()[index];
    if (param == nullptr)
        throw CommandError ("Parâmetro inexistente: " + juce::String (index));

    param->beginChangeGesture();
    param->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, value));
    param->endChangeGesture();
}

void PluginEffect::openEditor()
{
    if (window != nullptr)
    {
        window->toFront (true);
        return;
    }

    // A janela avisa de dentro dela; o fechamento acontece depois, fora dela.
    Ptr self (this);
    window = std::make_unique<PluginWindow> (*plugin, plugin->getName(), [self]
    {
        juce::MessageManager::callAsync ([self] { self->closeEditor(); });
    });
}

void PluginEffect::closeEditor()
{
    if (window == nullptr)
        return;

    window.reset();
    emitStateIfChanged();
    sendEvent ("chain.editorClosed", object ({ { "uid", uid } }));
}

//==============================================================================
void PluginEffect::audioProcessorParameterChanged (juce::AudioProcessor*, int index, float value)
{
    {
        const juce::SpinLock::ScopedLockType lock (pendingLock);
        pendingParams[index] = value;
    }
    dirty = true;
    triggerAsyncUpdate();
}

void PluginEffect::audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails&)
{
    dirty = true;
    triggerAsyncUpdate();
}

void PluginEffect::handleAsyncUpdate()
{
    std::map<int, float> changed;
    {
        const juce::SpinLock::ScopedLockType lock (pendingLock);
        changed.swap (pendingParams);
    }

    // Mantém os controles do painel em sincronia com a janela do plugin.
    for (const auto& [index, value] : changed)
        if (auto* param = plugin->getParameters()[index])
            sendEvent ("chain.paramChanged", object ({ { "uid", uid }, { "index", index }, { "value", value },
                                                       { "text", param->getText (value, maxTextLength) } }));

    if (const int latency = plugin->getLatencySamples(); latency != lastLatency)
    {
        lastLatency = latency;
        if (onLatencyChanged)
            onLatencyChanged();
    }

    if (dirty.exchange (false))
        startTimer (stateDebounceMs);
}

void PluginEffect::timerCallback()
{
    stopTimer();
    emitStateIfChanged();
}

void PluginEffect::emitStateIfChanged()
{
    stopTimer();
    if (offline)
        return;

    const auto state = currentState();
    if (state == lastState)
        return;

    lastState = state;
    // O estado agora não corresponde a nenhuma versão da interface: o próximo
    // estado que ela mandar (desfazer, refazer) é aplicado, seja qual for a versão.
    appliedVersion = -1;
    sendEvent ("chain.pluginState", object ({ { "uid", uid }, { "state", state } }));
}

} // namespace raven
