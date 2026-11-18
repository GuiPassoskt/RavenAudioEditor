#pragma once

#include "Dsp.h"

#include <juce_core/juce_core.h>

#include <array>
#include <atomic>

namespace raven
{

// Efeitos em tempo real embutidos: os mesmos de src/audio/realtime.js, com os
// mesmos parâmetros, processados em estéreo. Os parâmetros chegam do thread de
// mensagens (setState) e o thread de áudio os lê a cada bloco, sem lock.
class RealtimeEffect : public juce::ReferenceCountedObject
{
public:
    using Ptr = juce::ReferenceCountedObjectPtr<RealtimeEffect>;

    // nullptr para tipos desconhecidos.
    static Ptr create (const juce::String& type);

    // Thread de mensagens. A ordem é: create, setState, prepare.
    void setState (const juce::var& params, bool enabled);
    void prepare (double sampleRate, int maxBlockSize);
    // Efeitos com preparo assíncrono (reverb) precisam estar prontos antes de um render offline.
    virtual void waitUntilReady() {}

    // Thread de áudio.
    void reset();
    void process (juce::AudioBuffer<float>& buffer, int numSamples);

    double getSampleRate() const noexcept { return sampleRate; }

    const juce::String type;

protected:
    RealtimeEffect (juce::String typeIn, juce::StringArray keysIn);

    float param (int index) const noexcept { return params[(size_t) index].load (std::memory_order_relaxed); }

    virtual void onParamsChanged() {}  // thread de mensagens
    virtual void prepareEffect (int maxBlockSize) = 0;
    virtual void resetEffect() = 0;
    virtual void processEffect (juce::AudioBuffer<float>& buffer, int numSamples) = 0;

    double sampleRate = 44100.0;

private:
    juce::StringArray keys;
    std::array<std::atomic<float>, 8> params {};
    std::atomic<bool> enabled { true };
    juce::AudioBuffer<float> dry;
    dsp::Target wet;  // crossfade do liga/desliga, como os ganhos wet/dry de buildChain()
};

} // namespace raven
