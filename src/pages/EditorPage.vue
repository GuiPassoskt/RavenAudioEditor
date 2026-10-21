<template>
  <q-page :style-fn="fullHeight" class="column no-wrap">
    <div class="col tracks-slot">
      <TracksArea class="fill" />
    </div>
    <PianoRoll v-if="ui.pianoRoll !== null" />
    <MixerBoard v-if="ui.mixerOpen" />
  </q-page>
</template>

<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { keyName, useCommands } from 'src/composables/commands'
import TracksArea from 'components/TracksArea.vue'
import MixerBoard from 'components/MixerBoard.vue'
import PianoRoll from 'components/PianoRoll.vue'
import { useUiStore } from 'src/stores/ui'

const store = useProjectStore()
const ui = useUiStore()
const { keymap, exec } = useCommands()

const fullHeight = offset => ({ height: `calc(100vh - ${offset}px)` })

function onKey (e) {
  const target = e.target
  if (target.closest?.('input, textarea, select, [contenteditable], .q-dialog, .piano-roll')) return
  const name = keyName(e)
  const id = name && keymap.get(name)
  if (!id) return
  // Fase de captura + stopPropagation: o QBtn focado consome Espaço/Enter, então
  // o atalho precisa ser tratado antes dele. Tirar o foco evita o "clique" no keyup.
  e.preventDefault()
  e.stopPropagation()
  if (document.activeElement?.closest?.('.q-btn')) document.activeElement.blur()
  exec(id)
}

function onBeforeUnload (e) {
  if (store.dirty) {
    e.preventDefault()
    e.returnValue = ''
  }
}

onMounted(() => {
  if (!store.history.length) store.resetProject()
  // Tela de abertura, a menos que o usuário tenha marcado "Não mostrar ao iniciar".
  let hideSplash = false
  try { hideSplash = localStorage.getItem('raven.splash.hide') === '1' } catch { /* sem storage */ }
  if (!hideSplash) ui.splashOpen = true
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('beforeunload', onBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<style scoped>
.tracks-slot { position: relative; min-height: 0; }
.fill { position: absolute; inset: 0; }
</style>
