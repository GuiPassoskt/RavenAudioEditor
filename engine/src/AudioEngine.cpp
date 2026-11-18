#include "AudioEngine.h"

#include "Protocol.h"

#include <set>

namespace raven
{

static constexpr int maxBlock = 2048;
static constexpr double auditionSeconds = 0.35;  // auditionNote() de engine.js

static juce::var toVar (const juce::StringArray& strings)
{
    juce::Array<juce::var> result;
    for (const auto& s : strings)
        result.add (s);
    return result;
}

template <typename T>
static juce::var toVar (const juce::Array<T>& values)
{
    juce::Array<juce::var> result;
    for (const auto& v : values)
        result.add (v);
    return result;
}

static Clip::Ptr readClip (const juce::var& message)
{
    const int numChannels = message["channels"];
    const auto frames = static_cast<juce::int64> (message["frames"]);
    if (numChannels < 1 || numChannels > 2 || frames < 0 || frames > std::numeric_limits<int>::max())
        throw CommandError ("Clipe de áudio inválido.");

    Clip::Ptr clip = new Clip();
    clip->audio.setSize (numChannels, (int) frames);
    readPlanarFile (juce::File (message["file"].toString()), clip->audio);
    return clip;
}

//==============================================================================
// Fonte na taxa do projeto, lida pelo ResamplingAudioSource.
class AudioEngine::MixSource final : public juce::AudioSource
{
public:
    explicit MixSource (AudioEngine& e) : engine (e) { mix.setSize (2, maxBlock); }

    void prepareToPlay (int, double) override {}
    void releaseResources() override {}

    void getNextAudioBlock (const juce::AudioSourceChannelInfo& info) override
    {
        for (int done = 0; done < info.numSamples;)
        {
            const int n = juce::jmin (maxBlock, info.numSamples - done);
            engine.renderProject (mix, n);
            for (int c = 0; c < info.buffer->getNumChannels(); ++c)
                info.buffer->copyFrom (c, info.startSample + done, mix, juce::jmin (c, 1), 0, n);
            done += n;
        }
    }

private:
    AudioEngine& engine;
    juce::AudioBuffer<float> mix;
};

//==============================================================================
// Ao vivo: reaproveita estados de faixa, efeitos e notas entre grafos, para mudar
// o mix sem cortar notas nem caudas.
class AudioEngine::LiveResources final : public MixGraph::Resources
{
public:
    LiveResources (AudioEngine& e, double r) : engine (e), rate (r) {}

    TrackState::Ptr trackState (const juce::String& id) override
    {
        usedTracks.insert (id);
        auto& state = engine.trackStates[id];
        if (state == nullptr || state->sampleRate != rate)
        {
            state = new TrackState();
            state->prepare (rate, maxBlock);
        }
        return state;
    }

    Clip::Ptr clip (const juce::String& id) override
    {
        const auto it = engine.clips.find (id);
        return it != engine.clips.end() ? it->second : nullptr;
    }

    // As notas só vêm quando mudam (notesKey); senão, valem as da última vez.
    NoteList::Ptr notes (const juce::String& trackId, const juce::var& track) override
    {
        auto& entry = engine.notesCache[trackId];
        if (track["notes"].isArray())
            entry = { track["notesKey"].toString(), NoteList::fromJson (track["notes"]) };
        return entry.second;
    }

    RealtimeEffect::Ptr effect (const juce::var& state) override
    {
        const auto uid = state["uid"].toString();
        const auto type = state["type"].toString();
        usedEffects.insert (uid);

        if (type == "plugin")
            return pluginEffect (uid, state, false);

        auto& fx = engine.effects[uid];
        if (fx != nullptr && fx->type == type && fx->getSampleRate() == rate)
        {
            fx->setState (state["params"], state["enabled"]);
            return fx;
        }

        fx = RealtimeEffect::create (type);
        if (fx != nullptr)
        {
            fx->setState (state["params"], state["enabled"]);
            fx->prepare (rate, maxBlock);
        }
        return fx;
    }

    PluginEffect::Ptr instrument (const juce::var& state) override
    {
        const auto uid = state["uid"].toString();
        usedEffects.insert (uid);
        return dynamic_cast<PluginEffect*> (pluginEffect (uid, state, true).get());
    }

    // Plugin numa cadeia (ou instrumento de faixa MIDI): reaproveita a instância
    // enquanto o plugin e a taxa não mudarem.
    RealtimeEffect::Ptr pluginEffect (const juce::String& uid, const juce::var& state, bool isInstrument)
    {
        const auto pluginId = state["pluginId"].toString();
        auto& fx = engine.effects[uid];
        auto* existing = dynamic_cast<PluginEffect*> (fx.get());

        if (existing == nullptr || existing->pluginId != pluginId || existing->getSampleRate() != rate
            || existing->instrument != isInstrument)
        {
            // Plugin que já falhou não é carregado de novo a cada mudança do projeto.
            if (engine.failedPlugins.count (uid) && engine.failedPlugins[uid] == pluginId)
                return nullptr;

            juce::String error;
            auto instance = engine.plugins.createPlugin (pluginId, rate, maxBlock, error);
            if (instance == nullptr)
            {
                engine.failedPlugins[uid] = pluginId;
                fx = nullptr;
                sendEvent ("chain.pluginError", object ({ { "uid", uid }, { "message", error } }));
                return nullptr;
            }

            engine.failedPlugins.erase (uid);
            PluginEffect::Ptr created = new PluginEffect (uid, pluginId, std::move (instance), false, isInstrument);
            created->onLatencyChanged = [e = &engine] { e->rebuildGraph(); };
            created->setState ({}, state["enabled"]);
            applyPluginState (*created, state);
            created->prepare (rate, maxBlock);
            fx = created.get();
            return fx;
        }

        existing->setState ({}, state["enabled"]);
        applyPluginState (*existing, state);
        return fx;
    }

    // O estado só vem quando a interface tem uma versão nova (abrir projeto, desfazer).
    static void applyPluginState (PluginEffect& fx, const juce::var& state)
    {
        if (! state.hasProperty ("state"))
            return;

        const auto version = static_cast<juce::int64> (state["stateVersion"]);
        if (version == fx.appliedVersion)
            return;

        fx.appliedVersion = version;
        const auto data = state["state"].toString();
        if (data.isEmpty())
            fx.restoreInitialState();
        else
            fx.applyState (data);
    }

    // Esquece o que saiu do projeto (o grafo antigo segura até sair de uso).
    void prune()
    {
        // Slot de plugin removido: fecha a janela dele.
        for (auto& [uid, fx] : engine.effects)
            if (! usedEffects.count (uid))
                if (auto* plugin = dynamic_cast<PluginEffect*> (fx.get()))
                    plugin->closeEditor();

        const auto eraseUnused = [] (auto& map, const std::set<juce::String>& used)
        {
            for (auto it = map.begin(); it != map.end();)
                it = used.count (it->first) ? std::next (it) : map.erase (it);
        };
        eraseUnused (engine.trackStates, usedTracks);
        eraseUnused (engine.notesCache, usedTracks);
        eraseUnused (engine.effects, usedEffects);
        eraseUnused (engine.failedPlugins, usedEffects);
    }

private:
    AudioEngine& engine;
    double rate;
    std::set<juce::String> usedTracks, usedEffects;
};

// Render offline: tudo novo, para não mexer no que está tocando.
class AudioEngine::OfflineResources final : public MixGraph::Resources
{
public:
    OfflineResources (AudioEngine& e, double r) : engine (e), rate (r) {}

    TrackState::Ptr trackState (const juce::String&) override
    {
        TrackState::Ptr state = new TrackState();
        state->prepare (rate, maxBlock);
        return state;
    }

    Clip::Ptr clip (const juce::String& id) override
    {
        const auto it = engine.clips.find (id);
        return it != engine.clips.end() ? it->second : nullptr;
    }

    NoteList::Ptr notes (const juce::String&, const juce::var& track) override
    {
        return NoteList::fromJson (track["notes"]);
    }

    RealtimeEffect::Ptr effect (const juce::var& state) override
    {
        if (state["type"].toString() == "plugin")
            return pluginEffect (state, false);

        auto fx = RealtimeEffect::create (state["type"].toString());
        if (fx != nullptr)
        {
            fx->setState (state["params"], state["enabled"]);
            fx->prepare (rate, maxBlock);
            created.push_back (fx);
        }
        return fx;
    }

    PluginEffect::Ptr instrument (const juce::var& state) override
    {
        return dynamic_cast<PluginEffect*> (pluginEffect (state, true).get());
    }

    std::vector<RealtimeEffect::Ptr> created;

private:
    // Instância nova do plugin, com o estado da instância ao vivo se ela existir
    // (pega ajustes feitos há menos de 400 ms, que a interface ainda não recebeu).
    RealtimeEffect::Ptr pluginEffect (const juce::var& state, bool isInstrument)
    {
        const auto uid = state["uid"].toString();
        juce::String error;
        auto instance = engine.plugins.createPlugin (state["pluginId"].toString(), rate, maxBlock, error);
        if (instance == nullptr)
        {
            sendEvent ("chain.pluginError", object ({ { "uid", uid }, { "message", error } }));
            return nullptr;
        }

        PluginEffect::Ptr fx = new PluginEffect (uid, state["pluginId"].toString(), std::move (instance), true, isInstrument);
        fx->setState ({}, state["enabled"]);

        const auto it = engine.effects.find (uid);
        auto* live = it != engine.effects.end() ? dynamic_cast<PluginEffect*> (it->second.get()) : nullptr;
        fx->applyState (live != nullptr ? live->currentState() : state["state"].toString());

        fx->prepare (rate, maxBlock);
        created.push_back (fx.get());
        return fx.get();
    }

    AudioEngine& engine;
    double rate;
};

//==============================================================================
AudioEngine::AudioEngine (juce::File settings, PluginHost& pluginHost)
    : settingsFile (std::move (settings)), plugins (pluginHost)
{
    mixSource = std::make_unique<MixSource> (*this);
    resampler = std::make_unique<juce::ResamplingAudioSource> (mixSource.get(), false, 2);
    deviceBuffer.setSize (2, 4096);

    std::unique_ptr<juce::XmlElement> saved;
    if (settingsFile.existsAsFile())
        saved = juce::parseXML (settingsFile);

    deviceError = deviceManager.initialise (0, 2, saved.get(), true);
    deviceManager.addAudioCallback (this);
    startTimerHz (30);
}

AudioEngine::~AudioEngine()
{
    stopTimer();
    if (midiInput != nullptr)
        midiInput->stop();
    midiInput.reset();
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
}

bool AudioEngine::handles (const juce::String& cmd)
{
    for (auto* prefix : { "audio.", "project.", "clips.", "transport.", "preview.", "synth.", "render.", "capture.", "midi." })
        if (cmd.startsWith (prefix))
            return true;
    return false;
}

juce::var AudioEngine::handle (const juce::String& cmd, const juce::var& message)
{
    if (cmd == "audio.status")      return status();
    if (cmd == "audio.devices")     return devices();
    if (cmd == "audio.setDevice")   return setDevice (message);
    if (cmd == "project.sync")      return syncProject (message);
    if (cmd == "project.setRate")   return setRate (message);
    if (cmd == "clips.load")        return loadClip (message);
    if (cmd == "clips.release")     return releaseClips (message);
    if (cmd == "transport.play")    return play (message);
    if (cmd == "transport.stop")    return stop();
    if (cmd == "preview.play")      return playPreview (message);
    if (cmd == "preview.stop")      return stopPreview();
    if (cmd == "synth.audition")    return audition (message);
    if (cmd == "render.offline")    return renderOffline (message);
    if (cmd == "capture.start")     return startCapture (message);
    if (cmd == "capture.read")      return readCapture (message);
    if (cmd == "capture.stop")      return stopCapture();
    if (cmd == "project.pluginInfo")        return pluginInfo (message);
    if (cmd == "project.setPluginParam")    return setPluginParam (message);
    if (cmd == "project.openPluginEditor")  return openPluginEditor (message);
    if (cmd == "project.closePluginEditor") return closePluginEditor (message);
    if (cmd == "midi.devices")              return midiDevices();
    if (cmd == "midi.setInput")             return setMidiInput (message);
    if (cmd == "midi.startRecording")       return startMidiRecording();
    if (cmd == "midi.read")                 return readMidiRecording();
    if (cmd == "midi.stopRecording")        return stopMidiRecording();
    if (cmd == "midi.simulate")             return simulateMidi (message);

    throw CommandError ("Comando desconhecido: " + cmd);
}

juce::var AudioEngine::status() const
{
    auto* device = deviceManager.getCurrentAudioDevice();
    return juce::var (object ({ { "type", deviceManager.getCurrentAudioDeviceType() },
                                { "device", device != nullptr ? device->getName() : juce::String() },
                                { "sampleRate", device != nullptr ? device->getCurrentSampleRate() : 0.0 },
                                { "bufferSize", device != nullptr ? device->getCurrentBufferSizeSamples() : 0 },
                                { "latencyMs", outputLatency.load() * 1000.0 },
                                { "inputs", device != nullptr ? device->getActiveInputChannels().countNumberOfSetBits() : 0 },
                                { "outputs", device != nullptr ? device->getActiveOutputChannels().countNumberOfSetBits() : 0 },
                                { "projectRate", projectRate.load() },
                                { "error", deviceError } }).get());
}

//==============================================================================
juce::var AudioEngine::devices()
{
    juce::Array<juce::var> types;
    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        types.add (juce::var (object ({ { "name", type->getTypeName() },
                                        { "outputs", toVar (type->getDeviceNames (false)) },
                                        { "inputs", toVar (type->getDeviceNames (true)) } }).get()));
    }

    const auto setup = deviceManager.getAudioDeviceSetup();
    auto* device = deviceManager.getCurrentAudioDevice();
    auto current = status();
    current.getDynamicObject()->setProperty ("output", setup.outputDeviceName);
    current.getDynamicObject()->setProperty ("input", setup.inputDeviceName);
    current.getDynamicObject()->setProperty ("sampleRates", device != nullptr ? toVar (device->getAvailableSampleRates()) : juce::var());
    current.getDynamicObject()->setProperty ("bufferSizes", device != nullptr ? toVar (device->getAvailableBufferSizes()) : juce::var());

    return juce::var (object ({ { "types", types }, { "current", current } }).get());
}

juce::var AudioEngine::setDevice (const juce::var& message)
{
    if (capturing)
        throw CommandError ("Pare a gravação antes de trocar o dispositivo de áudio.");

    const auto type = message["type"].toString();
    if (type.isNotEmpty() && type != deviceManager.getCurrentAudioDeviceType())
        deviceManager.setCurrentAudioDeviceType (type, true);

    auto setup = deviceManager.getAudioDeviceSetup();
    if (message.hasProperty ("output"))     setup.outputDeviceName = message["output"].toString();
    if (message.hasProperty ("input"))      setup.inputDeviceName = message["input"].toString();
    if ((int) message["bufferSize"] > 0)    setup.bufferSize = message["bufferSize"];
    if ((double) message["sampleRate"] > 0) setup.sampleRate = message["sampleRate"];
    setup.useDefaultOutputChannels = true;
    setup.useDefaultInputChannels = true;

    const auto error = deviceManager.setAudioDeviceSetup (setup, true);
    if (error.isNotEmpty())
        throw CommandError ("Não foi possível abrir o dispositivo: " + error);

    deviceError = {};
    saveSettings();
    return devices();
}

void AudioEngine::saveSettings()
{
    if (settingsFile == juce::File())
        return;

    settingsFile.getParentDirectory().createDirectory();
    if (auto xml = deviceManager.createStateXml())
        xml->writeTo (settingsFile);
}

//==============================================================================
void AudioEngine::setProjectRate (double rate)
{
    projectRate.store (rate);
    resampler->setResamplingRatio (rate / deviceRate.load());
}

void AudioEngine::keepUntilUnused (juce::ReferenceCountedObject* objectToKeep)
{
    releasePool.emplace_back (objectToKeep);
}

void AudioEngine::publishGraph (MixGraph::Ptr newGraph)
{
    keepUntilUnused (newGraph.get());
    const juce::SpinLock::ScopedLockType lock (graphLock);
    graph = std::move (newGraph);
}

static double validRate (const juce::var& value)
{
    const double rate = value;
    if (rate < 8000 || rate > 384000)
        throw CommandError ("Taxa de amostragem inválida.");
    return rate;
}

juce::var AudioEngine::setRate (const juce::var& message)
{
    const double rate = validRate (message["rate"]);
    if (rate != projectRate.load())
        setProjectRate (rate);
    return true;
}

juce::var AudioEngine::syncProject (const juce::var& message)
{
    const double rate = validRate (message["rate"]);
    if (rate != projectRate.load())
        setProjectRate (rate);

    LiveResources resources (*this, rate);
    auto newGraph = MixGraph::build (message, rate, true, resources);
    resources.prune();
    publishGraph (std::move (newGraph));
    lastProject = message;
    return true;
}

// Um plugin mudou a latência: monta o grafo de novo para recalcular a compensação.
void AudioEngine::rebuildGraph()
{
    if (lastProject.isObject())
        syncProject (lastProject);
}

PluginEffect& AudioEngine::livePlugin (const juce::var& message)
{
    const auto uid = message["uid"].toString();
    const auto it = effects.find (uid);
    if (auto* fx = it != effects.end() ? dynamic_cast<PluginEffect*> (it->second.get()) : nullptr)
        return *fx;

    throw CommandError (failedPlugins.count (uid) ? "O plugin deste efeito não carregou."
                                                  : "Plugin não encontrado no motor.");
}

//==============================================================================
juce::var AudioEngine::midiDevices()
{
    juce::Array<juce::var> inputs;
    for (const auto& device : juce::MidiInput::getAvailableDevices())
        inputs.add (juce::var (object ({ { "id", device.identifier }, { "name", device.name } }).get()));

    return juce::var (object ({ { "inputs", inputs }, { "current", midiInputId } }).get());
}

juce::var AudioEngine::setMidiInput (const juce::var& message)
{
    const auto id = message["id"].toString();
    if (id == midiInputId && (id.isEmpty() || midiInput != nullptr))
        return true;

    if (midiInput != nullptr)
        midiInput->stop();
    midiInput.reset();
    midiInputId = {};

    if (id.isNotEmpty())
    {
        midiInput = juce::MidiInput::openDevice (id, this);
        if (midiInput == nullptr)
            throw CommandError ("Não foi possível abrir a entrada MIDI.");
        midiInput->start();
        midiInputId = id;
    }
    return true;
}

void AudioEngine::queueMidi (const juce::MidiMessage& message)
{
    if (message.getRawDataSize() > 3 || message.isSysEx())
        return;

    const auto* raw = message.getRawData();
    const IncomingMidi e { raw[0], message.getRawDataSize() > 1 ? raw[1] : (juce::uint8) 0,
                           message.getRawDataSize() > 2 ? raw[2] : (juce::uint8) 0,
                           juce::Time::getMillisecondCounterHiRes() * 0.001 };

    const juce::SpinLock::ScopedLockType lock (midiQueueLock);
    const auto scope = midiQueueFifo.write (1);
    if (scope.blockSize1 > 0)
        midiQueue[(size_t) scope.startIndex1] = e;
}

void AudioEngine::handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message)
{
    queueMidi (message);
}

// Só para testes: injeta uma mensagem como se viesse do dispositivo MIDI.
juce::var AudioEngine::simulateMidi (const juce::var& message)
{
    queueMidi (juce::MidiMessage ((int) message["status"], (int) message["data1"], (int) message["data2"]));
    return true;
}

juce::var AudioEngine::startMidiRecording()
{
    midiRecordFifo.reset();
    midiRecording.store (true);
    return true;
}

// Eventos gravados desde a última leitura: tempo em segundos do projeto (já
// descontada a latência de saída: é o momento em que o músico ouviu).
juce::var AudioEngine::readMidiRecording()
{
    juce::Array<juce::var> events;
    const double rate = projectRate.load();
    const auto scope = midiRecordFifo.read (midiRecordFifo.getNumReady());
    scope.forEach ([&] (int index)
    {
        const auto& e = midiRecordQueue[(size_t) index];
        events.add (juce::var (object ({ { "t", (double) e.sample / rate }, { "status", (int) e.status },
                                         { "data1", (int) e.data1 }, { "data2", (int) e.data2 } }).get()));
    });
    return events;
}

juce::var AudioEngine::stopMidiRecording()
{
    midiRecording.store (false);
    return readMidiRecording();
}

juce::var AudioEngine::pluginInfo (const juce::var& message)
{
    return livePlugin (message).info();
}

juce::var AudioEngine::setPluginParam (const juce::var& message)
{
    livePlugin (message).setParameter (message["index"], static_cast<float> (message["value"]));
    return true;
}

juce::var AudioEngine::openPluginEditor (const juce::var& message)
{
    livePlugin (message).openEditor();
    return true;
}

juce::var AudioEngine::closePluginEditor (const juce::var& message)
{
    livePlugin (message).closeEditor();
    return true;
}

juce::var AudioEngine::loadClip (const juce::var& message)
{
    clips[message["clipId"].toString()] = readClip (message);
    return true;
}

juce::var AudioEngine::releaseClips (const juce::var& message)
{
    if (auto* ids = message["ids"].getArray())
        for (const auto& id : *ids)
            clips.erase (id.toString());
    return true;
}

juce::var AudioEngine::play (const juce::var& message)
{
    const double rate = projectRate.load();
    const auto start = (juce::int64) std::llround ((double) message["t0"] * rate);
    const auto end = (juce::int64) std::llround ((double) message["t1"] * rate);

    playing.store (false);
    playStart.store (start);
    playEnd.store (juce::jmax (start, end));
    position.store (start);
    ended.store (false);
    ++playSequence;
    playing.store (true);
    return true;
}

juce::var AudioEngine::stop()
{
    playing.store (false);
    return true;
}

juce::var AudioEngine::playPreview (const juce::var& message)
{
    auto clip = readClip (message);

    // A prévia toca na taxa do projeto: converte se o trecho veio em outra.
    const double rate = message.getProperty ("rate", projectRate.load());
    const double speed = rate / projectRate.load();
    if (std::abs (speed - 1.0) > 1.0e-9 && clip->audio.getNumSamples() > 0)
    {
        Clip::Ptr converted = new Clip();
        const auto& src = clip->audio;
        const int frames = (int) std::ceil (src.getNumSamples() / speed);
        converted->audio.setSize (src.getNumChannels(), frames);
        for (int c = 0; c < src.getNumChannels(); ++c)
        {
            juce::LagrangeInterpolator interpolator;
            interpolator.process (speed, src.getReadPointer (c), converted->audio.getWritePointer (c),
                                  frames, src.getNumSamples(), 0);
        }
        clip = converted;
    }

    keepUntilUnused (clip.get());
    const juce::SpinLock::ScopedLockType lock (graphLock);
    previewClip = clip;
    ++previewSequence;
    return true;
}

juce::var AudioEngine::stopPreview()
{
    const juce::SpinLock::ScopedLockType lock (graphLock);
    previewClip = nullptr;
    ++previewSequence;
    return true;
}

juce::var AudioEngine::audition (const juce::var& message)
{
    // Com a faixa informada, a nota toca pela própria faixa (instrumento e efeitos).
    if (message.hasProperty ("trackId") && graph != nullptr)
    {
        const int index = graph->trackIndex (message["trackId"].toString());
        if (index >= 0 && graph->tracks[(size_t) index].isMidi)
        {
            auto& st = *graph->tracks[(size_t) index].state;
            const auto pitch = (juce::uint8) juce::jlimit (0, 127, (int) message["pitch"]);
            const auto velocity = (juce::uint8) juce::jlimit (1, 127, (int) message.getProperty ("vel", 100));
            st.pushLive ({ 0x90, pitch, velocity, 0 });
            st.pushLive ({ 0x80, pitch, 0, (int) (auditionSeconds * projectRate.load()) });
            return true;
        }
    }

    const AuditionNote note { message["pitch"], message.getProperty ("vel", 100), message["program"], message["drum"] };
    const auto scope = auditionFifo.write (1);
    if (scope.blockSize1 > 0)
        auditionNotes[(size_t) scope.startIndex1] = note;
    return true;
}

juce::var AudioEngine::renderOffline (const juce::var& message)
{
    const auto& project = message["project"];
    const double rate = project["rate"];
    if (rate < 8000 || rate > 384000)
        throw CommandError ("Taxa de amostragem inválida.");

    OfflineResources resources (*this, rate);
    auto offline = MixGraph::build (project, rate, (bool) message["applyMaster"], resources);
    for (auto& fx : resources.created)
        fx->waitUntilReady();

    // Mesmo tamanho do OfflineAudioContext de engine.js.
    const auto start = (juce::int64) std::llround ((double) message["t0"] * rate);
    const auto frames = juce::jmax<juce::int64> (1, std::llround (((double) message["t1"] - (double) message["t0"]) * rate));
    if (frames > std::numeric_limits<int>::max())
        throw CommandError ("Trecho longo demais para renderizar.");

    juce::AudioBuffer<float> result (2, (int) frames);
    juce::AudioBuffer<float> block (2, maxBlock);
    MasterState master;
    master.prepare (rate);
    offline->locate (start);

    // Com plugins que atrasam o sinal, renderiza a mais e descarta o começo.
    const auto latency = (juce::int64) offline->totalLatency;
    for (juce::int64 done = 0; done < frames + latency;)
    {
        const int n = (int) juce::jmin<juce::int64> (maxBlock, frames + latency - done);
        block.clear();
        offline->render (block, n, start + done, start + frames, master);

        const auto from = juce::jmax<juce::int64> (done, latency);
        const auto count = done + n - from;
        if (count > 0)
            for (int c = 0; c < 2; ++c)
                result.copyFrom (c, (int) (from - latency), block, c, (int) (from - done), (int) count);
        done += n;
    }

    writePlanarFile (juce::File (message["output"].toString()), result);
    return juce::var (object ({ { "frames", frames } }).get());
}

//==============================================================================
// Abrir a entrada reabre o dispositivo inteiro (~1,7 s no WASAPI). Por isso ela
// abre na primeira gravação e fica aberta até o app fechar, como nas DAWs: as
// gravações seguintes começam na hora e parar é instantâneo.
juce::var AudioEngine::startCapture (const juce::var&)
{
    if (capturing)
        return true;

    auto setup = deviceManager.getAudioDeviceSetup();
    const auto before = setup;

    if (setup.inputDeviceName.isEmpty())
        if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        {
            const auto names = type->getDeviceNames (true);
            if (! names.isEmpty())
                setup.inputDeviceName = names[juce::jmax (0, type->getDefaultDeviceIndex (true))];
        }

    if (setup.inputDeviceName.isEmpty())
        throw CommandError ("Nenhum dispositivo de entrada de áudio encontrado.");

    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    setup.inputChannels.setRange (0, 2, true);

    if (! (setup == before))
    {
        const auto error = deviceManager.setAudioDeviceSetup (setup, false);
        if (error.isNotEmpty())
            throw CommandError (error);
    }

    // 30 s de folga na taxa do dispositivo; a interface lê a cada ~100 ms.
    captureRing.setSize (2, (int) (deviceRate.load() * 30));
    captureFifo.setTotalSize (captureRing.getNumSamples());
    captureFifo.reset();
    for (auto& carry : captureCarry)
        carry.clear();
    for (auto& interpolator : captureInterpolators)
        interpolator.reset();

    capturing.store (true);

    // Latência de ida e volta informada pelo driver: o take sai atrasado por ela.
    double latency = 0;
    if (auto* device = deviceManager.getCurrentAudioDevice())
        latency = (device->getInputLatencyInSamples() + device->getOutputLatencyInSamples()) / device->getCurrentSampleRate();

    return juce::var (object ({ { "deviceRate", deviceRate.load() }, { "latency", latency } }).get());
}

juce::var AudioEngine::readCapture (const juce::var& message)
{
    // Drena o FIFO.
    const auto scope = captureFifo.read (captureFifo.getNumReady());
    for (int c = 0; c < 2; ++c)
    {
        const auto* ring = captureRing.getReadPointer (c);
        auto& carry = captureCarry[(size_t) c];
        carry.insert (carry.end(), ring + scope.startIndex1, ring + scope.startIndex1 + scope.blockSize1);
        carry.insert (carry.end(), ring + scope.startIndex2, ring + scope.startIndex2 + scope.blockSize2);
    }

    // Converte da taxa do dispositivo para a do projeto.
    const double speed = deviceRate.load() / projectRate.load();
    const int available = (int) captureCarry[0].size();
    const int frames = std::abs (speed - 1.0) < 1.0e-9 ? available
                                                         : juce::jmax (0, (int) ((available - 8) / speed));

    juce::AudioBuffer<float> out (2, frames);
    for (int c = 0; c < 2; ++c)
    {
        auto& carry = captureCarry[(size_t) c];
        int used = frames;
        if (frames == available)
            out.copyFrom (c, 0, carry.data(), frames);
        else if (frames > 0)
            used = captureInterpolators[(size_t) c].process (speed, carry.data(), out.getWritePointer (c),
                                                             frames, available, 0);
        carry.erase (carry.begin(), carry.begin() + juce::jmin (used, (int) carry.size()));
    }

    writePlanarFile (juce::File (message["output"].toString()), out);
    return juce::var (object ({ { "frames", frames } }).get());
}

juce::var AudioEngine::stopCapture()
{
    capturing.store (false);
    return true;
}

//==============================================================================
void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    const double rate = device->getCurrentSampleRate();
    const int block = device->getCurrentBufferSizeSamples();
    deviceRate.store (rate);
    deviceBuffer.setSize (2, juce::jmax (block, 4096));
    resampler->setResamplingRatio (projectRate.load() / rate);
    resampler->prepareToPlay (block, rate);
    outputLatency.store ((device->getOutputLatencyInSamples() + block) / rate);
}

void AudioEngine::audioDeviceStopped()
{
    resampler->releaseResources();
}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputs, int numInputs,
                                                    float* const* outputs, int numOutputs, int numSamples,
                                                    const juce::AudioIODeviceCallbackContext&)
{
    // Entrada: medidor e gravação.
    if (numInputs > 0)
    {
        float peak = 0;
        for (int c = 0; c < juce::jmin (numInputs, 2); ++c)
            if (inputs[c] != nullptr)
                peak = juce::jmax (peak, juce::FloatVectorOperations::findMaximum (inputs[c], numSamples),
                                   -juce::FloatVectorOperations::findMinimum (inputs[c], numSamples));
        if (peak > inputPeak.load (std::memory_order_relaxed))
            inputPeak.store (peak, std::memory_order_relaxed);

        if (capturing.load())
        {
            // Entrada mono vira dois canais iguais.
            const auto scope = captureFifo.write (numSamples);
            for (int c = 0; c < 2; ++c)
            {
                const auto* src = inputs[juce::jmin (c, numInputs - 1)];
                auto* ring = captureRing.getWritePointer (c);
                if (src == nullptr)
                    continue;
                if (scope.blockSize1 > 0)
                    std::copy (src, src + scope.blockSize1, ring + scope.startIndex1);
                if (scope.blockSize2 > 0)
                    std::copy (src + scope.blockSize1, src + scope.blockSize1 + scope.blockSize2, ring + scope.startIndex2);
            }
        }
    }

    // Saída: o projeto, convertido para a taxa do dispositivo.
    for (int done = 0; done < numSamples;)
    {
        const int n = juce::jmin (deviceBuffer.getNumSamples(), numSamples - done);
        resampler->getNextAudioBlock (juce::AudioSourceChannelInfo (&deviceBuffer, 0, n));

        for (int c = 0; c < numOutputs; ++c)
            if (outputs[c] != nullptr)
            {
                if (c < 2)
                    juce::FloatVectorOperations::copy (outputs[c] + done, deviceBuffer.getReadPointer (c), n);
                else
                    juce::FloatVectorOperations::clear (outputs[c] + done, n);
            }

        done += n;
    }
}

void AudioEngine::renderProject (juce::AudioBuffer<float>& mix, int numSamples)
{
    mix.clear (0, numSamples);
    const double rate = projectRate.load();

    if (masterStateRate != rate)
    {
        masterState.prepare (rate);
        masterStateRate = rate;
    }

    if (auditionRate != rate)
    {
        auditionSynth.prepare (rate);
        auditionRate = rate;
    }

    // Pega o grafo e a prévia mais recentes (sem esperar, se o lock estiver ocupado).
    {
        const juce::SpinLock::ScopedTryLockType lock (graphLock);
        if (lock.isLocked())
        {
            if (audioGraph != graph)
                audioGraph = graph;

            if (audioPreviewSequence != previewSequence.load())
            {
                audioPreviewSequence = previewSequence.load();
                audioPreview = previewClip;
                previewPosition = 0;
            }
        }
    }

    // Transporte.
    if (const auto sequence = playSequence.load(); sequence != audioPlaySequence)
    {
        audioPlaySequence = sequence;
        if (audioGraph != nullptr)
            audioGraph->locate (playStart.load());
        masterState.snap = true;
    }

    // Entrada MIDI deste bloco (teclado/controlador). Cada mensagem fica na posição
    // proporcional ao tempo desde que chegou: o atraso é de um bloco, igual para
    // todas, e o espaçamento entre elas se mantém.
    midiBlock.clear();
    if (midiQueueFifo.getNumReady() > 0)
    {
        const double now = juce::Time::getMillisecondCounterHiRes() * 0.001;
        const auto scope = midiQueueFifo.read (midiQueueFifo.getNumReady());
        scope.forEach ([&] (int index)
        {
            const auto& e = midiQueue[(size_t) index];
            const int lag = (int) ((now - e.time) * rate);
            midiBlock.addEvent (juce::MidiMessage (e.status, e.data1, e.data2),
                                juce::jlimit (0, numSamples - 1, numSamples - 1 - lag));
        });
        midiActivity.store (true);
    }

    // Gravação MIDI: posição do transporte menos o que o músico ouviu atrasado
    // (latência de saída do dispositivo e dos plugins).
    if (midiRecording.load() && playing.load() && ! midiBlock.isEmpty())
    {
        const auto heardDelay = (juce::int64) std::llround (outputLatency.load() * rate)
                              + (audioGraph != nullptr ? audioGraph->totalLatency : 0);
        const auto blockStart = position.load();
        for (const auto meta : midiBlock)
        {
            const auto msg = meta.getMessage();
            if (! (msg.isNoteOnOrOff() || msg.isSustainPedalOn() || msg.isSustainPedalOff()))
                continue;
            const auto scope = midiRecordFifo.write (1);
            if (scope.blockSize1 > 0)
                midiRecordQueue[(size_t) scope.startIndex1] = { blockStart + meta.samplePosition - heardDelay,
                                                               msg.getRawData()[0], msg.getRawData()[1], msg.getRawData()[2] };
        }
    }

    // Parou: as notas soltam com o release (instrumentos e sintetizador).
    const bool isPlaying = playing.load();
    if (audioWasPlaying && ! isPlaying && audioGraph != nullptr)
        audioGraph->releaseNotes();
    audioWasPlaying = isPlaying;

    // Parado, o grafo continua: notas ao vivo, instrumentos e caudas de efeitos.
    if (! isPlaying && audioGraph != nullptr && audioGraph->sampleRate == rate)
        audioGraph->render (mix, numSamples, position.load(), playEnd.load(), masterState, false, &midiBlock);

    if (isPlaying && audioGraph != nullptr && audioGraph->sampleRate == rate)
    {
        // Continua depois do fim pelo tempo da latência dos plugins, para o final sair inteiro.
        auto pos = position.load();
        const auto end = playEnd.load();
        const auto stopAt = end + audioGraph->totalLatency;
        const int n = (int) juce::jlimit<juce::int64> (0, numSamples, stopAt - pos);
        if (n > 0)
            audioGraph->render (mix, n, pos, end, masterState, true, &midiBlock);

        pos += n;
        position.store (pos);
        if (pos >= stopAt)
        {
            playing.store (false);
            ended.store (true);
        }
    }

    // Prévia de efeito.
    if (audioPreview != nullptr)
    {
        const auto& audio = audioPreview->audio;
        const int n = juce::jmin (numSamples, audio.getNumSamples() - previewPosition);
        for (int c = 0; c < 2 && n > 0; ++c)
            mix.addFrom (c, 0, audio, juce::jmin (c, audio.getNumChannels() - 1), previewPosition, n);
        previewPosition += juce::jmax (0, n);
        if (previewPosition >= audio.getNumSamples())
            audioPreview = nullptr;
    }

    // Notas avulsas do piano roll.
    {
        const auto scope = auditionFifo.read (auditionFifo.getNumReady());
        const auto length = (juce::int64) (auditionSeconds * rate);
        scope.forEach ([&] (int index)
        {
            const auto& note = auditionNotes[(size_t) index];
            auditionSynth.noteOn (note.pitch, note.velocity, note.program, note.drum, 0, length);
        });
    }
    auditionSynth.render (mix, numSamples);

    // Medidor de saída (o que vai para o dispositivo, como o analisador do engine.js).
    const float peakL = mix.getMagnitude (0, 0, numSamples);
    const float peakR = mix.getMagnitude (1, 0, numSamples);
    if (peakL > masterPeakL.load (std::memory_order_relaxed)) masterPeakL.store (peakL, std::memory_order_relaxed);
    if (peakR > masterPeakR.load (std::memory_order_relaxed)) masterPeakR.store (peakR, std::memory_order_relaxed);
}

//==============================================================================
void AudioEngine::timerCallback()
{
    // Libera grafos e clipes que o thread de áudio não segura mais.
    releasePool.erase (std::remove_if (releasePool.begin(), releasePool.end(),
                                       [] (const auto& o) { return o->getReferenceCount() == 1; }),
                       releasePool.end());

    if (ended.exchange (false))
        sendEvent ("transport.ended", object ({ { "position", (double) playEnd.load() / projectRate.load() } }));

    // Parado também pode haver som (notas ao vivo, caudas de efeitos).
    const bool sounding = masterPeakL.load() > 1.0e-4f || masterPeakR.load() > 1.0e-4f || midiActivity.load();
    const bool active = playing.load() || capturing.load() || sounding;
    if (! active && ! wasActive)
    {
        masterPeakL.store (0);
        masterPeakR.store (0);
        inputPeak.store (0);
        return;
    }
    wasActive = active;

    // A posição desconta a latência de saída: é o que está saindo no alto-falante agora.
    const double rate = projectRate.load();
    const double graphLatency = graph != nullptr ? graph->totalLatency : 0;
    const auto heard = juce::jmax ((double) playStart.load(),
                                   (double) position.load() - outputLatency.load() * rate - graphLatency);

    juce::DynamicObject::Ptr tracks = new juce::DynamicObject();
    if (graph != nullptr)
        for (const auto& t : graph->tracks)
        {
            juce::Array<juce::var> peaks { t.state->peakL.exchange (0), t.state->peakR.exchange (0) };
            tracks->setProperty (t.id, peaks);
        }

    juce::Array<juce::var> master { masterPeakL.exchange (0), masterPeakR.exchange (0) };
    sendEvent ("meters", object ({ { "playing", playing.load() },
                                   { "capturing", capturing.load() },
                                   { "position", heard / rate },
                                   { "master", master },
                                   { "input", inputPeak.exchange (0) },
                                   { "midiIn", midiActivity.exchange (false) },
                                   { "tracks", juce::var (tracks.get()) } }));
}

} // namespace raven
