#include "Protocol.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_events/juce_events.h>

#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

#if JUCE_WINDOWS
 #include <fcntl.h>
 #include <io.h>
 #include <windows.h>
#else
 #include <unistd.h>
#endif

namespace raven
{

static std::mutex outputMutex;
static FILE* protocolOut = stdout;

// O canal do protocolo é uma cópia privada do stdout; o stdout do processo passa
// a apontar para o stderr. Plugins que imprimem no stdout (o FluidSynth dos AVL
// Drumkits, por exemplo) não corrompem mais as mensagens JSON.
void initStdio()
{
    std::fflush (stdout);

   #if JUCE_WINDOWS
    // Sem _O_BINARY o Windows troca "\n" por "\r\n" e reinterpreta bytes UTF-8.
    _setmode (_fileno (stdin), _O_BINARY);
    const int privateFd = _dup (_fileno (stdout));
    if (privateFd >= 0)
    {
        _setmode (privateFd, _O_BINARY);
        protocolOut = _fdopen (privateFd, "wb");
        _dup2 (_fileno (stderr), _fileno (stdout));
        SetStdHandle (STD_OUTPUT_HANDLE, GetStdHandle (STD_ERROR_HANDLE));  // quem escreve direto no handle
    }
   #else
    const int privateFd = dup (STDOUT_FILENO);
    if (privateFd >= 0)
    {
        protocolOut = fdopen (privateFd, "wb");
        dup2 (STDERR_FILENO, STDOUT_FILENO);
    }
   #endif

    if (protocolOut == nullptr)
        protocolOut = stdout;
}

void send (const juce::var& message)
{
    const auto options = juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none);
    const auto line = juce::JSON::toString (message, options).toStdString();

    // Eventos podem sair de outras threads (varredura, callbacks): uma linha por vez.
    const std::lock_guard lock (outputMutex);
    std::fwrite (line.data(), 1, line.size(), protocolOut);
    std::fputc ('\n', protocolOut);
    std::fflush (protocolOut);
}

juce::DynamicObject::Ptr object (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();

    for (const auto& [name, value] : properties)
        result->setProperty (name, value);

    return result;
}

void sendEvent (const juce::String& name, juce::DynamicObject::Ptr data)
{
    if (data == nullptr)
        data = new juce::DynamicObject();

    data->setProperty ("event", name);
    send (juce::var (data.get()));
}

void sendResult (const juce::var& id, const juce::var& result)
{
    send (juce::var (object ({ { "id", id }, { "ok", true }, { "result", result } }).get()));
}

void sendError (const juce::var& id, const juce::String& message)
{
    send (juce::var (object ({ { "id", id }, { "ok", false }, { "error", message } }).get()));
}

void startStdinReader (std::function<void (const juce::String&)> onLine,
                       std::function<void()> onClosed)
{
    // Thread destacada: std::getline não pode ser interrompido, e o processo
    // termina logo depois que o stdin fecha.
    std::thread ([onLine = std::move (onLine), onClosed = std::move (onClosed)]
    {
        std::string line;

        while (std::getline (std::cin, line))
        {
            if (! line.empty() && line.back() == '\r')
                line.pop_back();

            if (line.empty())
                continue;

            auto text = juce::String::fromUTF8 (line.data(), (int) line.size());
            juce::MessageManager::callAsync ([onLine, text] { onLine (text); });
        }

        juce::MessageManager::callAsync (onClosed);
    }).detach();
}

// Áudio entre o Electron e o motor: Float32 planar (um canal inteiro depois do outro).
void readPlanarFile (const juce::File& file, juce::AudioBuffer<float>& buffer)
{
    juce::FileInputStream in (file);
    if (in.failedToOpen())
        throw CommandError ("Não foi possível ler " + file.getFullPathName());

    constexpr int chunkBytes = 1 << 24;

    for (int c = 0; c < buffer.getNumChannels(); ++c)
    {
        auto* dest = reinterpret_cast<char*> (buffer.getWritePointer (c));
        auto remaining = (juce::int64) buffer.getNumSamples() * (juce::int64) sizeof (float);

        while (remaining > 0)
        {
            const int wanted = (int) juce::jmin<juce::int64> (remaining, chunkBytes);
            if (in.read (dest, wanted) != wanted)
                throw CommandError ("Arquivo de áudio incompleto: " + file.getFullPathName());

            dest += wanted;
            remaining -= wanted;
        }
    }
}

void writePlanarFile (const juce::File& file, const juce::AudioBuffer<float>& buffer)
{
    file.deleteFile();
    juce::FileOutputStream out (file);
    if (out.failedToOpen())
        throw CommandError ("Não foi possível gravar " + file.getFullPathName());

    for (int c = 0; c < buffer.getNumChannels(); ++c)
        if (! out.write (buffer.getReadPointer (c), (size_t) buffer.getNumSamples() * sizeof (float)))
            throw CommandError ("Falha ao gravar " + file.getFullPathName());

    out.flush();
}

} // namespace raven
