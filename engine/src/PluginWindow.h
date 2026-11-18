#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>

namespace raven
{

// Janela nativa de um plugin, aberta pelo motor fora do Electron (seção 5 de
// docs/INTEGRACAO-PLUGINS-NATIVOS.md). Plugins sem interface própria ganham a
// tela genérica do JUCE. onClose é chamado de dentro da janela: quem a possui
// deve destruí-la depois (MessageManager::callAsync).
class PluginWindow final : public juce::DocumentWindow
{
public:
    PluginWindow (juce::AudioPluginInstance& plugin, const juce::String& title, std::function<void()> onCloseIn)
        : DocumentWindow (title, juce::Colour (0xff1e1f22), DocumentWindow::closeButton),
          onClose (std::move (onCloseIn))
    {
        setUsingNativeTitleBar (true);

        juce::AudioProcessorEditor* editor = plugin.hasEditor() ? plugin.createEditorAndMakeActive() : nullptr;
        if (editor == nullptr)
            editor = new juce::GenericAudioProcessorEditor (plugin);

        setContentOwned (editor, true);
        setResizable (editor->isResizable(), false);

        // Fica acima da janela do Electron, como as janelas de plugin das DAWs.
        setAlwaysOnTop (true);
        centreWithSize (getWidth(), getHeight());
        setVisible (true);
        toFront (true);
    }

    void closeButtonPressed() override { onClose(); }

private:
    std::function<void()> onClose;
};

} // namespace raven
