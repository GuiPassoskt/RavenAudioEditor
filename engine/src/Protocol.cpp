#include "Protocol.h"

#include <juce_events/juce_events.h>

#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

#if JUCE_WINDOWS
 #include <fcntl.h>
 #include <io.h>
#endif

namespace raven
{

static std::mutex outputMutex;

void initStdio()
{
   #if JUCE_WINDOWS
    // Sem isso o Windows troca "\n" por "\r\n" e reinterpreta bytes UTF-8.
    _setmode (_fileno (stdin), _O_BINARY);
    _setmode (_fileno (stdout), _O_BINARY);
   #endif
}

void send (const juce::var& message)
{
    const auto options = juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none);
    const auto line = juce::JSON::toString (message, options).toStdString();

    // Eventos podem sair de outras threads (varredura, callbacks): uma linha por vez.
    const std::lock_guard lock (outputMutex);
    std::fwrite (line.data(), 1, line.size(), stdout);
    std::fputc ('\n', stdout);
    std::fflush (stdout);
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

} // namespace raven
