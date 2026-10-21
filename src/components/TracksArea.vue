<template>
  <div
    ref="root"
    class="tracks-area"
    :class="{ dragging: dragOver }"
    @wheel="onWheel"
    @dragover.prevent="dragOver = true"
    @dragleave.self="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div class="ruler-row">
      <div class="corner" :style="{ width: HEADER + 'px' }">
        <span class="mono">{{ store.tracks.length }} faixa(s)</span>
      </div>
      <div class="col ruler-wrap"><TimeRuler /></div>
    </div>

    <div ref="rows" class="rows">
      <TrackRow v-for="t in store.tracks" :key="t.id" :track="t" :header-width="HEADER" :height="t.channels.length > 1 ? 180 : 130" />

      <div v-if="!store.tracks.length" class="empty-state">
        <q-icon name="graphic_eq" size="64px" color="grey-7" />
        <div class="text-h6 q-mt-md">Nenhuma faixa no projeto</div>
        <div class="text-grey-6 q-mb-md">Arraste arquivos de áudio para cá, importe, gere um tom ou grave do microfone.</div>
        <div class="row q-gutter-sm justify-center">
          <q-btn unelevated color="primary" icon="file_upload" label="Importar áudio" @click="exec('importAudio')" />
          <q-btn outline color="negative" icon="fiber_manual_record" label="Gravar" @click="startRecording" />
          <q-btn outline color="grey-5" icon="waves" label="Gerar tom" @click="exec('gen:tone')" />
        </div>
      </div>
      <div v-else class="rows-filler" @pointerdown="store.selectNone()" />
    </div>

    <div class="hscroll-row">
      <div :style="{ width: HEADER + 'px' }" />
      <div ref="hscroll" class="hscroll col" @scroll="onHScroll">
        <div :style="{ width: contentPx + 'px', height: '1px' }" />
      </div>
    </div>

    <div v-if="playheadX !== null" class="playhead" :style="{ left: playheadX + 'px' }" />
    <div v-if="dragOver" class="drop-overlay">
      <q-icon name="file_download" size="48px" />
      <div>Solte para importar</div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { guard, useCommands } from 'src/composables/commands'
import TimeRuler from './TimeRuler.vue'
import TrackRow from './TrackRow.vue'

const HEADER = 190
const MAX_PX = 1e6 // navegadores limitam a largura de elementos; mapeamos proporcionalmente

const store = useProjectStore()
const { exec } = useCommands()
const root = ref(null)
const rows = ref(null)
const hscroll = ref(null)
const dragOver = ref(false)

const maxScroll = computed(() => Math.max(0, store.duration - store.viewSeconds * 0.5))
const contentPx = computed(() => Math.min(MAX_PX, (maxScroll.value + store.viewSeconds) * store.pps))

const playheadX = computed(() => {
  if (store.playhead === null) return null
  const x = (store.playhead - store.scrollTime) * store.pps
  return x < 0 || x > store.viewWidth ? null : HEADER + x
})

// Sincroniza a barra de rolagem nativa com store.scrollTime.
watch(() => [store.scrollTime, contentPx.value], async () => {
  await nextTick()
  const el = hscroll.value
  if (!el) return
  const range = el.scrollWidth - el.clientWidth
  const target = maxScroll.value > 0 ? store.scrollTime / maxScroll.value * range : 0
  if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target
})

function onHScroll () {
  const el = hscroll.value
  const range = el.scrollWidth - el.clientWidth
  if (range <= 0) return
  const t = el.scrollLeft / range * maxScroll.value
  // Ignora o eco do scroll programático feito pelo watch acima.
  if (Math.abs(t - store.scrollTime) * store.pps > 1) store.setScroll(t)
}

function onWheel (e) {
  const rect = root.value.getBoundingClientRect()
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    const t = store.scrollTime + (e.clientX - rect.left - HEADER) / store.pps
    store.zoomAt(e.deltaY < 0 ? 1.25 : 0.8, Math.max(0, t))
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault()
    store.setScroll(store.scrollTime + (e.deltaX || e.deltaY) / store.pps)
  }
}

// Tela vazia: cria uma faixa mono (selecionada) e já começa a gravar nela.
function startRecording () {
  store.newTrack(1)
  exec('record')
}

async function onDrop (e) {
  dragOver.value = false
  const files = [...e.dataTransfer.files]
  const project = files.find(f => /\.(ravenproj|reaproj)$/i.test(f.name))
  if (project) return guard(() => store.openProject(project), { loading: true })
  if (files.length) await guard(() => store.importFiles(files), { loading: true })
}
</script>

<style scoped>
.tracks-area { position: relative; display: flex; flex-direction: column; height: 100%; background: var(--ed-bg); overflow: hidden; }
.ruler-row { display: flex; flex: none; border-bottom: 1px solid var(--ed-border); }
.corner { flex: none; background: var(--ed-panel); border-right: 1px solid var(--ed-border); font-size: 11px; color: var(--ed-text-dim); display: flex; align-items: center; padding-left: 8px; }
.ruler-wrap { min-width: 0; }
.rows { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; }
.rows-filler { flex: 1; min-height: 40px; }
.hscroll-row { display: flex; flex: none; background: var(--ed-panel); border-top: 1px solid var(--ed-border); }
.hscroll { overflow-x: auto; overflow-y: hidden; height: 14px; }
.playhead { position: absolute; top: 0; bottom: 14px; width: 2px; margin-left: -1px; background: var(--ed-playhead); pointer-events: none; box-shadow: 0 0 6px var(--ed-playhead); }
.empty-state { margin: auto; text-align: center; padding: 40px; }
.drop-overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(139,92,246,0.15); border: 2px dashed var(--q-primary); pointer-events: none; font-size: 16px;
}
</style>
