#pragma once

#include <juce_core/juce_core.h>

namespace raven
{

// Modo "raven-engine --scan": procura plugins nas pastas padrão de cada formato
// e grava a lista em cacheFile (XML do KnownPluginList).
//
// Roda num processo próprio, iniciado pelo Electron: se um plugin derrubar a
// varredura, o deadMansPedalFile guarda o nome dele, e na próxima tentativa o
// JUCE o coloca na lista negra e segue com os outros.
bool runScan (const juce::File& cacheFile, const juce::File& deadMansPedalFile);

} // namespace raven
