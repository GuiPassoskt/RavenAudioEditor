<template>
  <div class="selection-bar row items-center no-wrap q-gutter-x-md q-px-md">
    <div class="row items-center q-gutter-x-sm">
      <span class="lbl">Taxa do projeto (Hz)</span>
      <q-select
        :model-value="store.rate" :options="RATES" dense dark options-dense borderless
        class="rate" @update:model-value="setRate"
      />
    </div>

    <div class="row items-center q-gutter-x-sm">
      <span class="lbl">Início</span>
      <q-input :model-value="fmt(store.sel.t0)" dense dark borderless class="time mono" @blur="e => setStart(e.target.value)" @keyup.enter="e => e.target.blur()" />
      <span class="lbl">Fim</span>
      <q-input :model-value="fmt(store.sel.t1)" dense dark borderless class="time mono" @blur="e => setEnd(e.target.value)" @keyup.enter="e => e.target.blur()" />
      <span class="lbl">Duração</span>
      <q-input :model-value="fmt(store.sel.t1 - store.sel.t0)" dense dark borderless class="time mono" @blur="e => setLength(e.target.value)" @keyup.enter="e => e.target.blur()" />
    </div>

    <q-space />
    <div class="row items-center q-gutter-x-sm">
      <span class="lbl">Posição de áudio</span>
      <span class="time-big mono">{{ fmt(store.playhead ?? store.sel.t0) }}</span>
    </div>
    <div class="lbl">Zoom: {{ zoomText }}</div>
  </div>
</template>

<script setup>
// Barra de seleção (SelectionBar + TimeToolBar do Audacity).
import { computed } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { formatTime, parseTime } from 'src/audio/time'
import { guard } from 'src/composables/commands'

const RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000]
const store = useProjectStore()
const fmt = t => formatTime(t)

const zoomText = computed(() => {
  const spp = store.rate / store.pps
  return spp >= 1 ? `${Math.round(spp)} amostras/px` : `${(1 / spp).toFixed(1)} px/amostra`
})

const setRate = r => guard(() => store.setRate(r), { loading: true })
const read = v => {
  const t = parseTime(v)
  return t === null || t < 0 ? null : t
}
const setStart = v => { const t = read(v); if (t !== null) store.setSelection(t, Math.max(t, store.sel.t1)) }
const setEnd = v => { const t = read(v); if (t !== null) store.setSelection(Math.min(t, store.sel.t0), t) }
const setLength = v => { const t = read(v); if (t !== null) store.setSelection(store.sel.t0, store.sel.t0 + t) }
</script>

<style scoped>
.selection-bar { background: var(--ed-panel); border-top: 1px solid var(--ed-border); height: 40px; font-size: 12px; }
.lbl { color: var(--ed-text-dim); font-size: 11.5px; white-space: nowrap; }
.rate { width: 80px; }
.time { width: 122px; background: #0b0812; border-radius: 4px; padding: 0 8px; }
.time :deep(input) { font-family: inherit; color: #c9b3ff; }
.time-big { font-size: 15px; color: #c9b3ff; background: #0b0812; border-radius: 4px; padding: 2px 10px; }
</style>
