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

void TrackState::prepare (double rate, int maxBlockSize)
{
    sampleRate = rate;
    scratch.setSize (2, maxBlockSize);
    synth.prepare (rate);
    gainL.prepare (rate, gainSmoothing);
    gainR.prepare (rate, gainSmoothing);
    snapGains = true;
    delayLine.setSize (2, (int) rate + 1);
    delayLine.clear();
    delayIndex = 0;
}

//==============================================================================
MixGraph::Ptr MixGraph::build (const juce::var& project, double rate, bool applyMaster, Resources& resources)
{
    MixGraph::Ptr graph = new MixGraph();
    graph->sampleRate = rate;

    const auto* tracks = project["tracks"].getArray();
    bool anySolo = false;
    if (tracks != nullptr)
        for (const auto& t : *tracks)
            anySolo = anySolo || (bool) t["solo"];

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

            if (t["kind"].toString() == "midi")
                track.notes = resources.notes (track.id, t);
            else if (t["clip"].isString())
                track.clip = resources.clip (t["clip"].toString());

            // channelVolumes() de buffer.js: pan linear do Audacity vezes o ganho em dB.
            const bool audible = ! (bool) t["mute"] && (! anySolo || (bool) t["solo"]);
            const float pan = t["pan"];
            const float volume = dsp::dbToGain ((double) t["gain"]);
            track.gainL = audible ? volume * (pan > 0 ? 1.0f - pan : 1.0f) : 0.0f;
            track.gainR = audible ? volume * (pan < 0 ? 1.0f + pan : 1.0f) : 0.0f;

            if (auto* effects = t["effects"].getArray())
                for (const auto& fx : *effects)
                    if (auto e = resources.effect (fx))
                        track.effects.push_back (e);

            graph->tracks.push_back (std::move (track));
        }
    }

    // Compensação de latência: todas as faixas saem atrasadas como a mais lenta.
    const auto chainLatency = [] (const std::vector<RealtimeEffect::Ptr>& chain)
    {
        int latency = 0;
        for (const auto& fx : chain)
            latency += juce::jmax (0, fx->getLatencySamples());
        return latency;
    };

    int slowest = 0;
    for (const auto& t : graph->tracks)
        slowest = juce::jmax (slowest, chainLatency (t.effects));
    for (auto& t : graph->tracks)
        t.compensation = juce::jmin (slowest - chainLatency (t.effects), t.state->delayLine.getNumSamples() - 1);

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
        for (auto& fx : t.effects)
            fx->reset();
    }

    for (auto& fx : masterEffects)
        fx->reset();
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
        if (until - from > minLength)
            st.synth.noteOn (n.pitch, n.velocity, t.program, t.drum, (int) (from - position), until - from);
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

void MixGraph::render (juce::AudioBuffer<float>& out, int numSamples, juce::int64 position, juce::int64 end,
                       MasterState& master)
{
    for (auto& t : tracks)
    {
        auto& st = *t.state;
        auto& buf = st.scratch;
        buf.clear (0, numSamples);

        if (t.clip != nullptr)
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

        if (t.notes != nullptr)
        {
            scheduleNotes (t, numSamples, position, end);
            st.synth.render (buf, numSamples);
        }

        for (auto& fx : t.effects)
            fx->process (buf, numSamples);

        if (t.compensation > 0)
        {
            auto& line = st.delayLine;
            const int size = line.getNumSamples();
            for (int c = 0; c < 2; ++c)
            {
                auto* d = line.getWritePointer (c);
                auto* x = buf.getWritePointer (c);
                int w = st.delayIndex;
                for (int i = 0; i < numSamples; ++i)
                {
                    d[w] = x[i];
                    x[i] = d[(w - t.compensation + size) % size];
                    w = (w + 1) % size;
                }
            }
            st.delayIndex = (st.delayIndex + numSamples) % size;
        }

        st.gainL.target = t.gainL;
        st.gainR.target = t.gainR;
        if (st.snapGains)
        {
            st.gainL.snap (t.gainL);
            st.gainR.snap (t.gainR);
            st.snapGains = false;
        }

        auto* l = buf.getWritePointer (0);
        auto* r = buf.getWritePointer (1);
        float peakL = 0, peakR = 0;
        for (int i = 0; i < numSamples; ++i)
        {
            l[i] *= st.gainL.next();
            r[i] *= st.gainR.next();
            peakL = juce::jmax (peakL, std::abs (l[i]));
            peakR = juce::jmax (peakR, std::abs (r[i]));
        }

        if (peakL > st.peakL.load (std::memory_order_relaxed)) st.peakL.store (peakL, std::memory_order_relaxed);
        if (peakR > st.peakR.load (std::memory_order_relaxed)) st.peakR.store (peakR, std::memory_order_relaxed);

        out.addFrom (0, 0, buf, 0, 0, numSamples);
        out.addFrom (1, 0, buf, 1, 0, numSamples);
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
