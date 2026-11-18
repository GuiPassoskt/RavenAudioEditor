// Seletor de instrumento de uma faixa MIDI (cabeçalho da faixa e piano roll):
// os programas General MIDI do sintetizador embutido e, no app desktop, um
// instrumento virtual (VSTi) escolhido no PluginPickerDialog (Fase 4).

import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { INSTRUMENTS } from 'src/audio/synth'
import { hasNativeEngine } from 'src/audio/plugins'
import { chainPlugin } from 'src/audio/engine-native'
import { notifyError } from 'src/composables/commands'

export function useInstrumentChoice () {
  const store = useProjectStore()
  const ui = useUiStore()

  const instrumentValue = track => (track.instrument ? 'plugin' : track.drum ? 128 : Math.floor(track.program / 8) * 8)

  const instrumentOptions = track => (hasNativeEngine
    ? [...INSTRUMENTS, { label: track.instrument ? track.instrument.plugin.name : 'Plugin (VSTi)…', value: 'plugin' }]
    : INSTRUMENTS)

  const chooseInstrument = (track, value) => {
    if (value === 'plugin') ui.instrumentPicker = track.id
    else store.setInstrument(track.id, value)
  }

  const openInstrument = track => chainPlugin.openEditor(track.instrument.uid).catch(notifyError)

  return { instrumentValue, instrumentOptions, chooseInstrument, openInstrument }
}
