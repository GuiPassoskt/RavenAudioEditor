#include "Scanner.h"

#include "Protocol.h"

#include <juce_audio_processors/juce_audio_processors.h>

namespace raven
{

static void saveList (const juce::KnownPluginList& list, const juce::File& cacheFile)
{
    if (auto xml = list.createXml())
        xml->writeTo (cacheFile);
}

bool runScan (const juce::File& cacheFile, const juce::File& deadMansPedalFile)
{
    if (cacheFile == juce::File())
    {
        sendEvent ("scan.error", object ({ { "message", "RAVEN_PLUGIN_CACHE não definido." } }));
        return false;
    }

    cacheFile.getParentDirectory().createDirectory();

    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager (formats);

    juce::KnownPluginList list;
    if (auto xml = juce::parseXML (cacheFile))
        list.recreateFromXml (*xml);

    for (auto* format : formats.getFormats())
    {
        if (! format->canScanForPlugins())
            continue;

        juce::PluginDirectoryScanner scanner (list, *format, format->getDefaultLocationsToSearch(),
                                              true, deadMansPedalFile);

        for (;;)
        {
            sendEvent ("scan.progress", object ({ { "format", format->getName() },
                                                  { "file", scanner.getNextPluginFileThatWillBeScanned() },
                                                  { "progress", scanner.getProgress() } }));

            juce::String name;
            const bool more = scanner.scanNextFile (true, name);

            // Grava a cada plugin: se o próximo derrubar o processo, nada se perde.
            saveList (list, cacheFile);

            if (! more)
                break;
        }

        for (const auto& file : scanner.getFailedFiles())
            sendEvent ("scan.failed", object ({ { "format", format->getName() }, { "file", file } }));
    }

    saveList (list, cacheFile);
    sendEvent ("scan.done", object ({ { "count", list.getNumTypes() },
                                      { "blacklisted", list.getBlacklistedFiles().size() } }));
    return true;
}

} // namespace raven
