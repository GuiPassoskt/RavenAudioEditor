// raven-engine: motor de áudio nativo do Raven Audio Editor.
//
// É um app JUCE sem janela principal (e não um "console app"), porque as
// janelas dos plugins precisam do laço de mensagens do JUCE. O Electron o inicia
// e conversa com ele pelo stdin/stdout (Protocol.h).
//
//   raven-engine          modo normal: atende comandos até o stdin fechar
//   raven-engine --scan   procura plugins, grava a lista e termina
//
// Caminhos vêm por variáveis de ambiente, para não depender de aspas na linha
// de comando: RAVEN_PLUGIN_CACHE (lista de plugins), RAVEN_SCAN_PEDAL e
// RAVEN_AUDIO_SETTINGS (dispositivo de áudio escolhido).

#include "AudioEngine.h"
#include "PluginHost.h"
#include "Protocol.h"
#include "Scanner.h"

#include <juce_gui_basics/juce_gui_basics.h>

class RavenEngineApplication final : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override    { return JUCE_APPLICATION_NAME_STRING; }
    const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override          { return true; }

    void initialise (const juce::String&) override
    {
        raven::initStdio();

        const juce::File cacheFile (juce::SystemStats::getEnvironmentVariable ("RAVEN_PLUGIN_CACHE", {}));

        if (getCommandLineParameterArray().contains ("--scan"))
        {
            const juce::File pedal (juce::SystemStats::getEnvironmentVariable ("RAVEN_SCAN_PEDAL", {}));
            setApplicationReturnValue (raven::runScan (cacheFile, pedal) ? 0 : 1);
            quit();
            return;
        }

        host = std::make_unique<raven::PluginHost> (cacheFile);
        audio = std::make_unique<raven::AudioEngine> (
            juce::File (juce::SystemStats::getEnvironmentVariable ("RAVEN_AUDIO_SETTINGS", {})), *host);

        raven::startStdinReader ([this] (const juce::String& line) { handleLine (line); },
                                 [this] { quit(); });

        raven::sendEvent ("ready", raven::object ({ { "version", getApplicationVersion() } }));
    }

    void shutdown() override
    {
        audio.reset();
        host.reset();
    }

    void systemRequestedQuit() override
    {
        quit();
    }

    void anotherInstanceStarted (const juce::String&) override {}

private:
    void handleLine (const juce::String& line)
    {
        const auto message = juce::JSON::parse (line);
        const auto id = message["id"];
        const auto cmd = message["cmd"].toString();

        if (host == nullptr)
            return;

        if (cmd == "quit")
        {
            raven::sendResult (id, true);
            quit();
            return;
        }

        try
        {
            if (raven::AudioEngine::handles (cmd))
            {
                raven::sendResult (id, audio->handle (cmd, message));
                return;
            }

            auto result = host->handle (cmd, message);
            if (cmd == "ping")
                result.getDynamicObject()->setProperty ("audio", audio->status());
            raven::sendResult (id, result);
        }
        catch (const std::exception& e)
        {
            raven::sendError (id, juce::String::fromUTF8 (e.what()));
        }
    }

    std::unique_ptr<raven::PluginHost> host;
    std::unique_ptr<raven::AudioEngine> audio;
};

START_JUCE_APPLICATION (RavenEngineApplication)
