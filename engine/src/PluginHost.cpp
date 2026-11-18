#include "PluginHost.h"

#include "PluginWindow.h"
#include "Protocol.h"

#include <limits>

namespace raven
{

static constexpr int blockSize = 512;
static constexpr int maxTextLength = 64;

//==============================================================================
class PluginHost::Instance final : private juce::AudioProcessorListener
{
public:
    Instance (int idIn, std::unique_ptr<juce::AudioPluginInstance> pluginIn,
              std::function<void (int, float)> onParameterChangedIn)
        : id (idIn), plugin (std::move (pluginIn)), onParameterChanged (std::move (onParameterChangedIn))
    {
        plugin->addListener (this);
    }

    ~Instance() override
    {
        plugin->removeListener (this);

        if (window != nullptr && keepEditorAlive (*plugin))
        {
            // Ver keepEditorAlive(): a janela e a instância ficam vivas até o motor encerrar.
            window->setVisible (false);
            window.release();
            plugin.release();
            return;
        }

        // A janela (e o editor dentro dela) precisa sumir antes do plugin.
        window.reset();
    }

    void closeWindow()
    {
        if (window != nullptr && keepEditorAlive (*plugin))
            window->setVisible (false);
        else
            window.reset();
    }

    const int id;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    std::unique_ptr<PluginWindow> window;

private:
    // Pode ser chamado do thread de áudio do plugin: só repassa.
    void audioProcessorParameterChanged (juce::AudioProcessor*, int index, float value) override
    {
        onParameterChanged (index, value);
    }

    void audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails&) override {}

    std::function<void (int, float)> onParameterChanged;
};

//==============================================================================
static juce::var describePlugin (const juce::PluginDescription& d)
{
    return juce::var (object ({ { "id", d.createIdentifierString() },
                                { "name", d.name },
                                { "vendor", d.manufacturerName },
                                { "format", d.pluginFormatName },
                                { "category", d.category },
                                { "version", d.version },
                                { "isInstrument", d.isInstrument },
                                { "inputs", d.numInputChannels },
                                { "outputs", d.numOutputChannels },
                                { "file", d.fileOrIdentifier } }).get());
}

juce::var describeParameter (const juce::AudioProcessorParameter& param)
{
    const auto value = param.getValue();

    // Parâmetros discretos viram uma lista de opções na interface.
    juce::Array<juce::var> options;
    if (param.isDiscrete() && ! param.isBoolean())
    {
        auto strings = param.getAllValueStrings();
        const int steps = param.getNumSteps();

        // Plugins VST3 não preenchem getAllValueStrings (Bypass, modos, presets):
        // os textos vêm do getText de cada passo.
        if (strings.isEmpty() && steps >= 2 && steps <= 128)
            for (int i = 0; i < steps; ++i)
                strings.add (param.getText ((float) i / (float) (steps - 1), maxTextLength));

        if (strings.size() <= 128)
            for (const auto& s : strings)
                options.add (s);
    }

    return juce::var (object ({ { "index", param.getParameterIndex() },
                                { "name", param.getName (maxTextLength) },
                                { "label", param.getLabel() },
                                { "value", value },
                                { "default", param.getDefaultValue() },
                                { "steps", param.getNumSteps() },
                                { "boolean", param.isBoolean() },
                                { "options", options },
                                { "text", param.getText (value, maxTextLength) } }).get());
}

juce::var describeParameters (juce::AudioPluginInstance& plugin)
{
    // Parâmetros não automatizáveis ficam de fora: em VST3 costumam ser os
    // milhares de controladores MIDI internos ("MIDI CC 0"…), não ajustes do som.
    juce::Array<juce::var> params;
    for (auto* param : plugin.getParameters())
        if (param->isAutomatable())
            params.add (describeParameter (*param));
    return params;
}

bool configureLayout (juce::AudioPluginInstance& plugin, int numChannels)
{
    auto layout = plugin.getBusesLayout();
    if (layout.inputBuses.isEmpty() || layout.outputBuses.isEmpty())
        return false;

    const auto channels = juce::AudioChannelSet::canonicalChannelSet (numChannels);
    layout.inputBuses.getReference (0) = channels;
    layout.outputBuses.getReference (0) = channels;

    if (plugin.checkBusesLayoutSupported (layout))
        plugin.setBusesLayout (layout);

    return plugin.getMainBusNumInputChannels() == numChannels
        && plugin.getMainBusNumOutputChannels() == numChannels;
}

// Processa o trecho inteiro mais rápido que o tempo real, em blocos, com
// compensação da latência que o plugin informa.
static void renderOffline (juce::AudioPluginInstance& plugin, const juce::AudioBuffer<float>& input,
                           juce::AudioBuffer<float>& output, double sampleRate)
{
    const int numChannels = input.getNumChannels();
    const int numFrames = input.getNumSamples();

    plugin.setNonRealtime (true);
    plugin.prepareToPlay (sampleRate, blockSize);
    plugin.reset();

    const int latency = juce::jmax (0, plugin.getLatencySamples());
    const int pluginIns = plugin.getTotalNumInputChannels();
    const int pluginOuts = plugin.getTotalNumOutputChannels();

    juce::AudioBuffer<float> block (juce::jmax (pluginIns, pluginOuts, 1), blockSize);
    juce::MidiBuffer midi;

    // Pré-rolo: muitos plugins suavizam mudanças de parâmetro (o kHs Gain leva
    // ~50 ms para chegar ao valor novo). Meio segundo de silêncio descartado
    // deixa os parâmetros assentados antes do primeiro bloco do trecho.
    for (int done = 0; done < (int) (sampleRate * 0.5); done += blockSize)
    {
        block.clear();
        midi.clear();
        plugin.processBlock (block, midi);
    }

    output.setSize (numChannels, numFrames, false, true);
    output.clear();

    const auto total = (juce::int64) numFrames + latency;

    for (juce::int64 pos = 0; pos < total; pos += blockSize)
    {
        const int n = (int) juce::jmin<juce::int64> (blockSize, total - pos);
        block.setSize (block.getNumChannels(), n, false, false, true);
        block.clear();

        // Depois do fim do trecho entra silêncio, para "esvaziar" a latência.
        const int available = (int) juce::jlimit<juce::int64> (0, n, numFrames - pos);
        if (available > 0)
            for (int c = 0; c < juce::jmin (numChannels, pluginIns); ++c)
                block.copyFrom (c, 0, input, c, (int) pos, available);

        midi.clear();
        plugin.processBlock (block, midi);

        // A saída chega `latency` amostras atrasada: desloca de volta.
        const auto outPos = pos - latency;
        const int skip = (int) juce::jmax<juce::int64> (0, -outPos);
        const auto dest = juce::jmax<juce::int64> (0, outPos);
        const int count = (int) juce::jmin<juce::int64> (n - skip, numFrames - dest);

        if (count <= 0 || pluginOuts == 0)
            continue;

        for (int c = 0; c < numChannels; ++c)
            output.copyFrom (c, (int) dest, block, juce::jmin (c, pluginOuts - 1), skip, count);
    }

    plugin.releaseResources();
}

//==============================================================================
PluginHost::PluginHost (juce::File cacheFileIn)
    : cacheFile (std::move (cacheFileIn))
{
    juce::addDefaultFormatsToManager (formatManager);
    reloadKnownPlugins();
}

PluginHost::~PluginHost()
{
    instances.clear();
}

juce::var PluginHost::handle (const juce::String& cmd, const juce::var& message)
{
    if (cmd == "ping")             return ping();
    if (cmd == "plugins.list")     return listPlugins();
    if (cmd == "fx.create")        return createInstance (message);
    if (cmd == "fx.setParam")      return setParam (message);
    if (cmd == "fx.openEditor")    return openEditor (message);
    if (cmd == "fx.closeEditor")   return closeEditor (message);
    if (cmd == "fx.process")       return process (message);
    if (cmd == "fx.destroy")       return destroyInstance (message);

    throw CommandError ("Comando desconhecido: " + cmd);
}

juce::var PluginHost::ping() const
{
    juce::Array<juce::var> formats;
    for (auto* format : formatManager.getFormats())
        formats.add (format->getName());

    return juce::var (object ({ { "name", JUCE_APPLICATION_NAME_STRING },
                                { "version", JUCE_APPLICATION_VERSION_STRING },
                                { "juce", juce::SystemStats::getJUCEVersion() },
                                { "formats", formats } }).get());
}

void PluginHost::reloadKnownPlugins()
{
    // A lista é gravada pelo processo de varredura (Scanner.cpp).
    knownPlugins.clear();
    if (auto xml = juce::parseXML (cacheFile))
        knownPlugins.recreateFromXml (*xml);
}

std::unique_ptr<juce::AudioPluginInstance> PluginHost::createPlugin (const juce::String& pluginId, double sampleRate,
                                                                    int maxBlockSize, juce::String& error)
{
    reloadKnownPlugins();
    const auto description = knownPlugins.getTypeForIdentifierString (pluginId);
    if (description == nullptr)
    {
        error = "Plugin não encontrado. Procure os plugins instalados de novo.";
        return nullptr;
    }

    juce::String loadError;
    auto plugin = formatManager.createPluginInstance (*description, sampleRate, maxBlockSize, loadError);
    if (plugin == nullptr)
        error = "Não foi possível carregar \"" + description->name + "\": " + loadError;
    return plugin;
}

juce::var PluginHost::listPlugins()
{
    reloadKnownPlugins();

    juce::Array<juce::var> result;
    for (const auto& description : knownPlugins.getTypes())
        result.add (describePlugin (description));

    return result;
}

juce::var PluginHost::createInstance (const juce::var& message)
{
    const auto pluginId = message["pluginId"].toString();
    const auto sampleRate = static_cast<double> (message.getProperty ("sampleRate", 44100.0));

    juce::String error;
    auto plugin = createPlugin (pluginId, sampleRate, blockSize, error);
    if (plugin == nullptr)
        throw CommandError (error);

    const int id = nextInstanceId++;
    auto& instance = *(instances[id] = std::make_unique<Instance> (
        id, std::move (plugin), [this, id] (int index, float value) { onParameterChanged (id, index, value); }));

    const auto params = describeParameters (*instance.plugin);

    return juce::var (object ({ { "instanceId", id },
                                { "pluginId", pluginId },
                                { "name", instance.plugin->getName() },
                                { "hasEditor", instance.plugin->hasEditor() },
                                { "latency", instance.plugin->getLatencySamples() },
                                { "params", params } }).get());
}

juce::var PluginHost::setParam (const juce::var& message)
{
    auto& instance = getInstance (message);
    const int index = message["index"];

    auto* param = instance.plugin->getParameters()[index];
    if (param == nullptr)
        throw CommandError ("Parâmetro inexistente: " + juce::String (index));

    const auto value = juce::jlimit (0.0f, 1.0f, static_cast<float> (message["value"]));
    param->beginChangeGesture();
    param->setValueNotifyingHost (value);
    param->endChangeGesture();

    const auto current = param->getValue();
    return juce::var (object ({ { "value", current }, { "text", param->getText (current, maxTextLength) } }).get());
}

juce::var PluginHost::openEditor (const juce::var& message)
{
    auto& instance = getInstance (message);

    if (instance.window == nullptr)
    {
        const int id = instance.id;
        instance.window = std::make_unique<PluginWindow> (*instance.plugin, instance.plugin->getName(),
                                                          [this, id] { onEditorClosed (id); });
    }
    else
    {
        instance.window->setVisible (true);
        instance.window->toFront (true);
    }

    return true;
}

juce::var PluginHost::closeEditor (const juce::var& message)
{
    getInstance (message).closeWindow();
    return true;
}

juce::var PluginHost::process (const juce::var& message)
{
    auto& instance = getInstance (message);
    auto& plugin = *instance.plugin;

    const auto sampleRate = static_cast<double> (message["sampleRate"]);
    const int numChannels = message["channels"];
    const auto numFrames = static_cast<juce::int64> (message["frames"]);

    if (sampleRate <= 0 || numChannels <= 0 || numFrames < 0 || numFrames > std::numeric_limits<int>::max())
        throw CommandError ("Parâmetros de áudio inválidos.");

    juce::AudioBuffer<float> input (numChannels, (int) numFrames);
    readPlanarFile (juce::File (message["input"].toString()), input);

    juce::AudioBuffer<float> output;

    if (configureLayout (plugin, numChannels))
    {
        renderOffline (plugin, input, output, sampleRate);
    }
    else if (numChannels > 1 && configureLayout (plugin, 1))
    {
        // Plugin só mono numa faixa estéreo: processa um canal por vez.
        output.setSize (numChannels, (int) numFrames);

        for (int c = 0; c < numChannels; ++c)
        {
            juce::AudioBuffer<float> channelIn (input.getArrayOfWritePointers() + c, 1, (int) numFrames);
            juce::AudioBuffer<float> channelOut;
            renderOffline (plugin, channelIn, channelOut, sampleRate);
            output.copyFrom (c, 0, channelOut, 0, 0, (int) numFrames);
        }
    }
    else
    {
        // Layout próprio do plugin: entra e sai o que couber.
        renderOffline (plugin, input, output, sampleRate);
    }

    writePlanarFile (juce::File (message["output"].toString()), output);

    return juce::var (object ({ { "frames", numFrames }, { "latency", plugin.getLatencySamples() } }).get());
}

juce::var PluginHost::destroyInstance (const juce::var& message)
{
    instances.erase (getInstance (message).id);
    return true;
}

PluginHost::Instance& PluginHost::getInstance (const juce::var& message)
{
    const int id = message["instanceId"];
    const auto it = instances.find (id);
    if (it == instances.end())
        throw CommandError ("Instância de plugin não encontrada (o motor pode ter sido reiniciado).");

    return *it->second;
}

void PluginHost::onParameterChanged (int instanceId, int index, float value)
{
    // Pode vir de qualquer thread: o envio acontece no thread de mensagens.
    juce::MessageManager::callAsync ([this, instanceId, index, value]
    {
        const auto it = instances.find (instanceId);
        if (it == instances.end())
            return;

        auto* param = it->second->plugin->getParameters()[index];
        sendEvent ("fx.paramChanged", object ({ { "instanceId", instanceId },
                                                { "index", index },
                                                { "value", value },
                                                { "text", param != nullptr ? param->getText (value, maxTextLength) : juce::String() } }));
    });
}

void PluginHost::onEditorClosed (int instanceId)
{
    // Chamado de dentro da própria janela: ela só pode ser destruída depois.
    juce::MessageManager::callAsync ([this, instanceId]
    {
        const auto it = instances.find (instanceId);
        if (it == instances.end())
            return;

        it->second->closeWindow();
        sendEvent ("fx.editorClosed", object ({ { "instanceId", instanceId } }));
    });
}

} // namespace raven
