<template>
  <div class="mixer-board column no-wrap">
    <div class="mixer-head row items-center no-wrap q-px-sm">
      <q-icon name="tune" size="16px" class="q-mr-xs" />
      <span class="text-caption text-weight-medium">Mesa de som</span>
      <span class="text-caption text-grey-6 q-ml-sm">clique nos inserts para editar os efeitos · duplo clique no fader volta a 0 dB</span>
      <q-space />
      <q-btn flat dense round size="sm" icon="close" title="Fechar (Ctrl+M)" @click="ui.mixerOpen = false" />
    </div>
    <div class="mixer-body row no-wrap col">
      <div class="strips row no-wrap col">
        <MixerStrip v-for="t in store.tracks" :key="t.id" :track="t" :levels="levels[t.id] ?? ZERO" />
        <div v-if="!store.tracks.length" class="text-grey-6 q-pa-md">Sem faixas.</div>
      </div>
      <div class="master-wrap">
        <MixerStrip :levels="masterLevels" />
      </div>
    </div>
  </div>
</template>

<script setup>
// Mesa de som (MixerBoard do Audacity, src/MixerBoard.cpp): uma coluna por faixa
// e uma coluna master, com medidores pós-fader alimentados pelo grafo ao vivo.

import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { engine } from 'src/audio/engine'
import MixerStrip from './MixerStrip.vue'

const ZERO = [0, 0]
const store = useProjectStore()
const ui = useUiStore()
const levels = reactive({})
const masterLevels = ref(ZERO)
let raf = 0
let idle = false

function tick () {
  if (store.playing || store.recording) {
    for (const t of store.tracks) levels[t.id] = engine.voiceLevels(t.id)
    masterLevels.value = engine.meterLevels()
    idle = false
  } else if (!idle) {
    for (const k of Object.keys(levels)) levels[k] = ZERO
    masterLevels.value = ZERO
    idle = true
  }
  raf = requestAnimationFrame(tick)
}

onMounted(() => { raf = requestAnimationFrame(tick) })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<style scoped>
.mixer-board { height: 330px; flex: none; background: var(--ed-bg); border-top: 2px solid var(--ed-border); }
.mixer-head { height: 28px; background: var(--ed-panel); border-bottom: 1px solid var(--ed-border); }
.mixer-body { min-height: 0; padding: 6px; gap: 6px; }
.strips { gap: 6px; overflow-x: auto; overflow-y: hidden; min-width: 0; }
.master-wrap { flex: none; padding-left: 6px; border-left: 1px solid var(--ed-border); }
</style>
