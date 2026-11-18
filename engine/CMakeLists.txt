# Motor de áudio nativo do Raven Audio Editor (raven-engine), feito com JUCE.
# Arquitetura e protocolo: docs/INTEGRACAO-PLUGINS-NATIVOS.md, seção 4.
#
#   cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release
#   cmake --build engine/build --config Release
#
# O executável final é copiado para engine/bin/, onde o Electron o procura.

cmake_minimum_required(VERSION 3.22)
project(RavenEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(third_party/JUCE)

juce_add_gui_app(RavenEngine
  PRODUCT_NAME "raven-engine"
  COMPANY_NAME "Raven Audio Editor"
  ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/../src-electron/electron-assets/icons/icon.png"
  NEEDS_WEB_BROWSER FALSE
  NEEDS_CURL FALSE)

target_sources(RavenEngine PRIVATE
  src/Main.cpp
  src/PluginHost.cpp
  src/Protocol.cpp
  src/Scanner.cpp)

target_compile_definitions(RavenEngine PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_LV2=1
  JUCE_PLUGINHOST_AU=1  # só tem efeito no macOS
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:RavenEngine,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:RavenEngine,JUCE_VERSION>")

# ASIO (Windows): o JUCE 9 já traz o ASIO SDK 2.3, usado aqui sob a opção GPLv3
# (seção 7 do documento). Só faz diferença quando o motor tocar áudio (Fase 2).
#   cmake ... -DRAVEN_ASIO=ON
option(RAVEN_ASIO "Suporte a drivers ASIO no Windows" OFF)
if(WIN32 AND RAVEN_ASIO)
  target_compile_definitions(RavenEngine PRIVATE JUCE_ASIO=1)
endif()

target_link_libraries(RavenEngine
  PRIVATE
    juce::juce_audio_utils
    juce::juce_dsp
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

set(RAVEN_ENGINE_BIN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/bin")
if(APPLE)
  add_custom_command(TARGET RavenEngine POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "$<TARGET_BUNDLE_DIR:RavenEngine>" "${RAVEN_ENGINE_BIN_DIR}/raven-engine.app")
else()
  add_custom_command(TARGET RavenEngine POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${RAVEN_ENGINE_BIN_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:RavenEngine>" "${RAVEN_ENGINE_BIN_DIR}/")
endif()
