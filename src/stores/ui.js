import { defineStore } from 'pinia'

// Estado puramente visual (diálogos e painéis abertos).
export const useUiStore = defineStore('ui', {
  state: () => ({
    effect: null, // { def, kind: 'effect' | 'generate' }
    pluginEffect: false, // diálogo de plugin nativo (VST3/LV2), só no desktop
    audioDevicesOpen: false, // dispositivos de áudio do motor nativo, só no desktop
    instrumentPicker: null, // id da faixa MIDI escolhendo um instrumento virtual (VSTi)
    analysis: null, // 'spectrum' | 'clipping' | 'stats'
    historyOpen: false,
    mixerOpen: false, // Mesa de som (MixerBoard)
    pianoRoll: null, // id da faixa MIDI aberta no piano roll
    fxTarget: null, // painel de efeitos em tempo real: id da faixa ou 'master'
    envelopeParam: 'gain', // automação editada pela ferramenta de envelope: 'gain' | 'pan'
    shortcutsOpen: false,
    aboutOpen: false,
    splashOpen: false // tela de abertura com informações técnicas
  })
})
