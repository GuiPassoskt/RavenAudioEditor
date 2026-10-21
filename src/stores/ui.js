import { defineStore } from 'pinia'

// Estado puramente visual (diálogos e painéis abertos).
export const useUiStore = defineStore('ui', {
  state: () => ({
    effect: null, // { def, kind: 'effect' | 'generate' }
    analysis: null, // 'spectrum' | 'clipping' | 'stats'
    historyOpen: false,
    mixerOpen: false, // Mesa de som (MixerBoard)
    pianoRoll: null, // id da faixa MIDI aberta no piano roll
    fxTarget: null, // painel de efeitos em tempo real: id da faixa ou 'master'
    shortcutsOpen: false,
    aboutOpen: false,
    splashOpen: false // tela de abertura com informações técnicas
  })
})
