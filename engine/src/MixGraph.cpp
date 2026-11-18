#include "MixGraph.h"

#include <algorithm>

namespace raven
{

static constexpr double gainSmoothing = 0.01;  // applyMix() de engine.js: setTargetAtTime(…, 0.01)

NoteList::Ptr NoteList::fromJson (const juce::var& json)
{
    NoteList::Ptr list = new NoteList();

    if (auto* array = json.getArray())
    {
        list->notes.reserve ((size_t) array->size());
        for (const auto& n : *array)
        {
            const double start = n["start"];
            list->notes.push_back ({ start, start + (double) n["dur"], (int) n["pitch"], (int) n["vel"] });
        }
    }

    std::stable_sort (list->notes.begin(), list->notes.end(),
                      [] (const Note& a, const Note& b) { return a.start < b.start; });
    return list;
}

bool TrackState::pushLive (LiveEvent e)
{
    const auto scope = liveFifo.write (1);
    if (scope.blockSize1 == 0)
        return false;
    liveQueue[(size_t) scope.startIndex1] = e;
    return true;
}

void TrackState::prepare (double rate, int maxBlockSize)
{
    midi.ensureSize (4096);
    sampleRate = rate;
    scratch.setSize (2, maxBlockSize);
    synth.prepare (rate);
    gainL.prepare (rate, gainSmoothing);
    gainR.prepare (rate, gainSmoothing);
    snapGains = true;
    delayLine.setSize (2, (int) rate + 1);
    delayLine.clear();
    delayIndex = 0;
    busDelayLine.setSize (2, (int) rate + 1);
    busDelayLine.clear();
    busDelayIndex = 0;
}

//==============================================================================
MixGraph::Ptr MixGraph::build (const juce::var& project, double rate, bool applyMaster, Resources& resources)
{
    MixGraph::Ptr graph = new MixGraph();
    graph->sampleRate = rate;

    const auto* tracks = project["tracks"].getArray();
    // Barramentos não entram no solo ("solo safe"): o solo de uma faixa não cala o
    // reverb compartilhado que ela alimenta.
    bool anySolo = false;
    if (tracks != nullptr)
        for (const auto& t : *tracks)
            anySolo = anySolo || ((bool) t["solo"] && t["kind"].toString() != "bus");

    const auto envelope = [] (const juce::var& points)
    {
        std::vector<Track::Point> result;
        if (auto* array = points.getArray())
            for (const auto& p : *array)
                result.push_back ({ (double) p["t"], (float) p["v"] });
        std::sort (result.begin(), result.end(), [] (const auto& a, const auto& b) { return a.time < b.time; });
        return result;
    };

    if (tracks != nullptr)
    {
        for (const auto& t : *tracks)
        {
            Track track;
            track.id = t["id"].toString();
            track.state = resources.trackState (track.id);
            track.offset = t["offset"];
            track.program = t["program"];
            track.drum = t["drum"];
            track.isMidi = t["kind"].toString() == "midi";
            track.isBus = t["kind"].toString() == "bus";

            if (track.isMidi)
            {
                track.notes = resources.notes (track.id, t);
                if (t["instrument"].isObject())
                    track.instrument = resources.instrument (t["instrument"]);
            }
            else if (t["clip"].isString())
                track.clip = resources.clip (t["clip"].toString());

            // channelVolumes() de buffer.js: pan linear do Audacity vezes o ganho em dB.
            track.audible = ! (bool) t["mute"] && (track.isBus || ! anySolo || (bool) t["solo"]);
            track.pan = t["pan"];
            track.volume = dsp::dbToGain ((double) t["gain"]);
            track.gainL = track.audible ? track.volume * (track.pan > 0 ? 1.0f - track.pan : 1.0f) : 0.0f;
            track.gainR = track.audible ? track.volume * (track.pan < 0 ? 1.0f + track.pan : 1.0f) : 0.0f;
            track.gainEnvelope = envelope (t["automation"]["gain"]);
            track.panEnvelope = envelope (t["automation"]["pan"]);

            if (auto* effects = t["effects"].getArray())
                for (const auto& fx : *effects)
                    if (auto e = resources.effect (fx))
                        track.effects.push_back (e);

            graph->tracks.push_back (std::move (track));
        }
    }

    // Envios: o id do barramento vira índice.
    if (tracks != nullptr)
        for (size_t i = 0; i < graph->tracks.size(); ++i)
            if (auto* sends = (*tracks)[(int) i]["sends"].getArray())
                for (const auto& s : *sends)
                {
                    const int bus = graph->trackIndex (s["bus"].toString());
                    if (bus >= 0 && graph->tracks[(size_t) bus].isBus && ! graph->tracks[i].isBus)
                        graph->tracks[i].sends.push_back ({ bus, dsp::dbToGain ((double) s["level"]) });
                }

    // Compensação de latência: todas as faixas saem atrasadas como a mais lenta.
    const auto chainLatency = [] (const std::vector<RealtimeEffect::Ptr>& chain)
    {
        int latency = 0;
        for (const auto& fx : chain)
            latency += juce::jmax (0, fx->getLatencySamples());
        return latency;
    };

    const auto trackLatency = [&] (const Track& t)
    {
        return chainLatency (t.effects) + (t.instrument != nullptr ? juce::jmax (0, t.instrument->getLatencySamples()) : 0);
    };

    // Faixas alinham entre si; o que passa por um barramento ainda leva a latência
    // dele, então a saída direta das faixas espera a do barramento mais lento.
    int slowest = 0, slowestBus = 0;
    for (const auto& t : graph->tracks)
        (t.isBus ? slowestBus : slowest) = juce::jmax (t.isBus ? slowestBus : slowest, trackLatency (t));
    for (auto& t : graph->tracks)
    {
        const int limit = t.state->delayLine.getNumSamples() - 1;
        t.compensation = juce::jmin ((t.isBus ? slowestBus : slowest) - trackLatency (t), limit);
        t.busDelay = t.isBus ? 0 : juce::jmin (slowestBus, limit);
        t.automationDelay = t.isBus ? slowest + slowestBus : slowest;
    }
    slowest += slowestBus;

    if (applyMaster)
    {
        const auto& master = project["master"];
        graph->masterGain = dsp::dbToGain ((double) master["gain"]);
        if (auto* effects = master["effects"].getArray())
            for (const auto& fx : *effects)
                if (auto e = resources.effect (fx))
                    graph->masterEffects.push_back (e);
    }

    graph->totalLatency = slowest + chainLatency (graph->masterEffects);
    graph->midiTarget = graph->trackIndex (project["midiTarget"].toString());
    if (graph->midiTarget >= 0 && ! graph->tracks[(size_t) graph->midiTarget].isMidi)
        graph->midiTarget = -1;
    return graph;
}

void MixGraph::locate (juce::int64)
{
    for (auto& t : tracks)
    {
        t.state->synth.allNotesOff();
        t.state->startFromHere = true;
        t.state->snapGains = true;
        t.state->delayLine.clear();
        t.state->delayIndex = 0;
        t.state->busDelayLine.clear();
        t.state->busDelayIndex = 0;
        t.state->panic = true;
        if (t.instrument != nullptr)
            t.instrument->reset();
        for (auto& fx : t.effects)
            fx->reset();
    }

    for (auto& fx : masterEffects)
        fx->reset();
}

void MixGraph::releaseNotes()
{
    for (auto& t : tracks)
        t.state->releaseRequested = true;
}

int MixGraph::trackIndex (const juce::String& id) const
{
    for (size_t i = 0; i < tracks.size(); ++i)
        if (tracks[i].id == id)
            return (int) i;
    return -1;
}

// Eventos MIDI do bloco: pedidos de soltar/cortar, "note off" pendentes dos
// instrumentos e notas ao vivo. Com o sintetizador embutido, viram chamadas a ele.
void MixGraph::collectMidi (Track& t, int numSamples, juce::int64 position, bool running, const juce::MidiBuffer* live)
{
    auto& st = *t.state;
    auto& midi = st.midi;

    if (st.panic || st.releaseRequested)
    {
        for (int i = 0; i < st.numPendingOffs; ++i)
            midi.addEvent (juce::MidiMessage::noteOff (1, st.pendingOffs[(size_t) i].pitch), 0);
        st.numPendingOffs = 0;

        if (t.instrument != nullptr)
            midi.addEvent (juce::MidiMessage::allNotesOff (1), 0);
        else if (st.panic)
            st.synth.allNotesOff();
        else
            st.synth.releaseAll();

        st.panic = st.releaseRequested = false;
    }

    if (running)
    {
        // "Note off" das notas do projeto que terminam neste bloco.
        for (int i = 0; i < st.numPendingOffs;)
        {
            const auto& off = st.pendingOffs[(size_t) i];
            if (off.sample < position + numSamples)
            {
                midi.addEvent (juce::MidiMessage::noteOff (1, off.pitch), (int) juce::jmax<juce::int64> (0, off.sample - position));
                st.pendingOffs[(size_t) i] = st.pendingOffs[(size_t) --st.numPendingOffs];
            }
            else
            {
                ++i;
            }
        }
    }

    // Notas ao vivo: as que caem neste bloco entram; as outras esperam.
    {
        const auto scope = st.liveFifo.read (st.liveFifo.getNumReady());
        scope.forEach ([&] (int index)
        {
            if (st.numDelayed < (int) st.delayed.size())
                st.delayed[(size_t) st.numDelayed++] = st.liveQueue[(size_t) index];
        });
    }

    for (int i = 0; i < st.numDelayed;)
    {
        auto& e = st.delayed[(size_t) i];
        if (e.delay < numSamples)
        {
            midi.addEvent (juce::MidiMessage (e.status, e.data1, e.data2), e.delay);
            st.delayed[(size_t) i] = st.delayed[(size_t) --st.numDelayed];
        }
        else
        {
            e.delay -= numSamples;
            ++i;
        }
    }

    // Teclado/controlador MIDI (só na faixa alvo).
    if (live != nullptr)
        midi.addEvents (*live, 0, numSamples, 0);
}

void MixGraph::scheduleNotes (Track& t, int numSamples, juce::int64 position, juce::int64 end)
{
    auto& st = *t.state;
    const auto& notes = t.notes->notes;
    const auto toSample = [&] (double seconds) { return (juce::int64) std::llround ((t.offset + seconds) * sampleRate); };
    const auto minLength = (juce::int64) (0.002 * sampleRate);

    const auto trigger = [&] (const NoteList::Note& n, juce::int64 from)
    {
        const auto until = juce::jmin (toSample (n.end), end);
        if (until - from <= minLength)
            return;

        if (t.instrument == nullptr)
        {
            st.synth.noteOn (n.pitch, n.velocity, t.program, t.drum, (int) (from - position), until - from);
        }
        else if (st.numPendingOffs < (int) st.pendingOffs.size())
        {
            st.midi.addEvent (juce::MidiMessage::noteOn (1, n.pitch, (juce::uint8) juce::jlimit (1, 127, n.velocity)),
                              (int) (from - position));
            st.pendingOffs[(size_t) st.numPendingOffs++] = { until, n.pitch };
        }
    };

    // Reposiciona o cursor: no início da reprodução (as notas que já soam tocam
    // daqui em diante, como no motor Web Audio) e quando as notas mudam.
    if (st.startFromHere || st.scheduledNotes != t.notes.get() || st.expectedPosition != position)
    {
        if (st.startFromHere)
            for (const auto& n : notes)
                if (toSample (n.start) < position && toSample (n.end) > position)
                    trigger (n, position);

        st.cursor = (size_t) (std::lower_bound (notes.begin(), notes.end(), position,
                                                [&] (const NoteList::Note& n, juce::int64 p) { return toSample (n.start) < p; })
                              - notes.begin());
        st.scheduledNotes = t.notes.get();
        st.startFromHere = false;
    }

    const auto blockEnd = juce::jmin (position + numSamples, end);
    while (st.cursor < notes.size() && toSample (notes[st.cursor].start) < blockEnd)
    {
        const auto& n = notes[st.cursor++];
        trigger (n, juce::jmax (position, toSample (n.start)));
    }

    st.expectedPosition = position + numSamples;
}

// Atraso em linha (até 1 s) usado na compensação de latência.
static void delayBuffer (juce::AudioBuffer<float>& buf, juce::AudioBuffer<float>& line, int& index, int delay, int numSamples)
{
    if (delay <= 0)
        return;

    const int size = line.getNumSamples();
    for (int c = 0; c < 2; ++c)
    {
        auto* d = line.getWritePointer (c);
        auto* x = buf.getWritePointer (c);
        int w = index;
        for (int i = 0; i < numSamples; ++i)
        {
            d[w] = x[i];
            x[i] = d[(w - delay + size) % size];
            w = (w + 1) % size;
        }
    }
    index = (index + numSamples) % size;
}

// Interpolação linear entre os pontos; antes do primeiro e depois do último, o valor deles.
static float envelopeAt (const std::vector<MixGraph::Track::Point>& points, double time)
{
    if (time <= points.front().time) return points.front().value;
    if (time >= points.back().time) return points.back().value;
    const auto next = std::upper_bound (points.begin(), points.end(), time,
                                        [] (double x, const auto& p) { return x < p.time; });
    const auto prev = next - 1;
    const double f = (time - prev->time) / (next->time - prev->time);
    return (float) (prev->value + (next->value - prev->value) * f);
}

// Efeitos, compensação, ganho/pan (com automação) e medidores de uma faixa ou barramento.
void MixGraph::finishTrack (Track& t, int numSamples, juce::int64 position)
{
    auto& st = *t.state;
    auto& buf = st.scratch;

    for (auto& fx : t.effects)
        fx->process (buf, numSamples);

    delayBuffer (buf, st.delayLine, st.delayIndex, t.compensation, numSamples);

    const bool automated = ! t.gainEnvelope.empty() || ! t.panEnvelope.empty();
    const auto targetsAt = [&] (juce::int64 sample)
    {
        if (! automated)
            return std::pair<float, float> { t.gainL, t.gainR };
        if (! t.audible)
            return std::pair<float, float> { 0.0f, 0.0f };

        const double time = (double) (sample - t.automationDelay) / sampleRate - t.offset;
        const float volume = t.gainEnvelope.empty() ? t.volume : t.volume * dsp::dbToGain (envelopeAt (t.gainEnvelope, time));
        const float pan = t.panEnvelope.empty() ? t.pan : juce::jlimit (-1.0f, 1.0f, envelopeAt (t.panEnvelope, time));
        return std::pair<float, float> { volume * (pan > 0 ? 1.0f - pan : 1.0f), volume * (pan < 0 ? 1.0f + pan : 1.0f) };
    };

    if (st.snapGains)
    {
        const auto [gl, gr] = targetsAt (position);
        st.gainL.snap (gl);
        st.gainR.snap (gr);
        st.snapGains = false;
    }

    auto* l = buf.getWritePointer (0);
    auto* r = buf.getWritePointer (1);
    float peakL = 0, peakR = 0;
    for (int i = 0; i < numSamples; ++i)
    {
        if (i % 32 == 0)
        {
            const auto [gl, gr] = targetsAt (position + i);
            st.gainL.target = gl;
            st.gainR.target = gr;
        }
        l[i] *= st.gainL.next();
        r[i] *= st.gainR.next();
        peakL = juce::jmax (peakL, std::abs (l[i]));
        peakR = juce::jmax (peakR, std::abs (r[i]));
    }

    if (peakL > st.peakL.load (std::memory_order_relaxed)) st.peakL.store (peakL, std::memory_order_relaxed);
    if (peakR > st.peakR.load (std::memory_order_relaxed)) st.peakR.store (peakR, std::memory_order_relaxed);
}

void MixGraph::render (juce::AudioBuffer<float>& out, int numSamples, juce::int64 position, juce::int64 end,
                       MasterState& master, bool running, const juce::MidiBuffer* midiInput)
{
    // Barramentos começam vazios: as faixas somam os envios neles.
    for (auto& t : tracks)
        if (t.isBus)
            t.state->scratch.clear (0, numSamples);

    for (size_t index = 0; index < tracks.size(); ++index)
    {
        auto& t = tracks[index];
        if (t.isBus)
            continue;

        auto& st = *t.state;
        auto& buf = st.scratch;
        buf.clear (0, numSamples);

        if (running && t.clip != nullptr)
        {
            // Mono vira estéreo (L = R) antes dos efeitos, como o upmix de createVoice().
            const auto& audio = t.clip->audio;
            const auto clipStart = (juce::int64) std::llround (t.offset * sampleRate);
            const auto from = juce::jmax (position, clipStart);
            const auto to = juce::jmin (position + numSamples, clipStart + audio.getNumSamples(), end);

            if (to > from)
                for (int c = 0; c < 2; ++c)
                    buf.copyFrom (c, (int) (from - position), audio, juce::jmin (c, audio.getNumChannels() - 1),
                                  (int) (from - clipStart), (int) (to - from));
        }

        if (t.isMidi)
        {
            st.midi.clear();
            collectMidi (t, numSamples, position, running, (int) index == midiTarget ? midiInput : nullptr);
            if (running && t.notes != nullptr)
                scheduleNotes (t, numSamples, position, end);

            if (t.instrument != nullptr)
            {
                t.instrument->renderInstrument (buf, numSamples, st.midi);
            }
            else
            {
                // Sintetizador embutido: os eventos ao vivo viram notas sem fim / note off.
                for (const auto meta : st.midi)
                {
                    const auto msg = meta.getMessage();
                    if (msg.isNoteOn())
                        st.synth.noteOn (msg.getNoteNumber(), msg.getVelocity(), t.program, t.drum,
                                         meta.samplePosition, Synth::untilNoteOff);
                    else if (msg.isNoteOff())
                        st.synth.noteOff (msg.getNoteNumber(), meta.samplePosition);
                }
                st.synth.render (buf, numSamples);
            }
        }

        finishTrack (t, numSamples, position);

        // Envios pós-fader para os barramentos.
        for (const auto& send : t.sends)
            for (int c = 0; c < 2; ++c)
                tracks[(size_t) send.bus].state->scratch.addFrom (c, 0, buf, c, 0, numSamples, send.gain);

        delayBuffer (buf, st.busDelayLine, st.busDelayIndex, t.busDelay, numSamples);
        out.addFrom (0, 0, buf, 0, 0, numSamples);
        out.addFrom (1, 0, buf, 1, 0, numSamples);
    }

    for (auto& t : tracks)
    {
        if (! t.isBus)
            continue;

        finishTrack (t, numSamples, position);
        out.addFrom (0, 0, t.state->scratch, 0, 0, numSamples);
        out.addFrom (1, 0, t.state->scratch, 1, 0, numSamples);
    }

    for (auto& fx : masterEffects)
        fx->process (out, numSamples);

    master.fader.target = masterGain;
    if (master.snap)
    {
        master.fader.snap (masterGain);
        master.snap = false;
    }

    auto* l = out.getWritePointer (0);
    auto* r = out.getWritePointer (1);
    for (int i = 0; i < numSamples; ++i)
    {
        const float g = master.fader.next();
        l[i] *= g;
        r[i] *= g;
    }
}

} // namespace raven
