#pragma once

// Canal de controle com o Electron: uma mensagem JSON por linha.
//
//   pedido   (stdin):  {"id": 7, "cmd": "fx.create", ...argumentos}
//   resposta (stdout): {"id": 7, "ok": true, "result": ...}
//                      {"id": 7, "ok": false, "error": "mensagem"}
//   evento   (stdout): {"event": "fx.paramChanged", ...dados}

#include <juce_core/juce_core.h>

#include <functional>
#include <stdexcept>

namespace raven
{

// Erro esperado de um comando: vira {"ok": false, "error": ...} para a interface.
class CommandError : public std::runtime_error
{
public:
    explicit CommandError (const juce::String& message)
        : std::runtime_error (message.toStdString()) {}
};

void initStdio();

void send (const juce::var& message);
void sendEvent (const juce::String& name, juce::DynamicObject::Ptr data = {});
void sendResult (const juce::var& id, const juce::var& result);
void sendError (const juce::var& id, const juce::String& message);

// Lê o stdin numa thread própria e entrega cada linha no thread de mensagens.
// onClosed é chamado quando o Electron fecha o pipe (o app foi encerrado).
void startStdinReader (std::function<void (const juce::String&)> onLine,
                       std::function<void()> onClosed);

// Atalho para montar objetos JSON: object ({{"a", 1}, {"b", "x"}}).
juce::DynamicObject::Ptr object (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties);

} // namespace raven
