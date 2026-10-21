<template>
  <div class="track-row" :class="{ selected: track.selected, recording: isRec }" :data-track-id="track.id" :style="colorVars">
    <div class="track-header" :style="{ width: headerWidth + 'px', height: height + 'px' }" @pointerdown.self="select">
      <div class="row items-center no-wrap q-gutter-x-xs">
        <button type="button" class="track-icon" :title="`Cor da faixa: ${colorName}`">
          <q-icon :name="track.kind === 'midi' ? (track.drum ? 'mdi-instrument-triangle' : 'mdi-piano') : 'graphic_eq'" size="16px" />
          <q-menu dark anchor="bottom left" self="top left">
            <div class="swatches q-pa-sm">
              <div class="text-caption text-grey-5 q-mb-xs">Cor da faixa</div>
              <div class="row q-gutter-xs" style="width: 168px">
                <button
                  v-for="c in TRACK_COLORS" :key="c.value" v-close-popup type="button" class="swatch"
                  :class="{ active: c.value === track.color }" :style="{ background: c.value }" :title="c.name"
                  @click="store.setTrackProp(track.id, 'color', c.value)"
                />
              </div>
            </div>
          </q-menu>
        </button>
        <div class="track-name ellipsis col" :title="track.name">
          <span v-if="isRec" class="rec-chip">● REC</span>
          {{ track.name }}
          <q-popup-edit v-slot="scope" :model-value="track.name" auto-save dark @save="v => store.setTrackProp(track.id, 'name', v)">
            <q-input v-model="scope.value" dense autofocus dark @keyup.enter="scope.set" />
          </q-popup-edit>
        </div>
        <q-btn
          flat dense round size="xs" icon="mdi-tune-vertical" :color="activeFx ? 'positive' : 'grey-5'"
          :title="`Efeitos em tempo real (${track.effects.length})`" @click="ui.fxTarget = track.id"
        >
          <q-badge v-if="track.effects.length" floating rounded color="positive" text-color="black" :label="track.effects.length" class="fx-badge" />
        </q-btn>
        <q-btn flat dense round size="xs" icon="more_vert">
          <q-menu dark>
            <q-list dense style="min-width: 180px">
              <q-item v-close-popup clickable @click="store.moveTrack(track.id, -1)"><q-item-section>Mover para cima</q-item-section></q-item>
              <q-item v-close-popup clickable @click="store.moveTrack(track.id, 1)"><q-item-section>Mover para baixo</q-item-section></q-item>
              <q-separator dark />
              <q-item v-close-popup clickable @click="selectWhole"><q-item-section>Selecionar faixa inteira</q-item-section></q-item>
              <q-item v-close-popup clickable @click="ui.fxTarget = track.id"><q-item-section>Efeitos em tempo real…</q-item-section></q-item>
              <q-separator dark />
              <q-item>
                <q-item-section>
                  <div class="text-caption text-grey-5 q-mb-xs">Cor da faixa</div>
                  <div class="row q-gutter-xs">
                    <button
                      v-for="c in TRACK_COLORS" :key="c.value" v-close-popup type="button" class="swatch"
                      :class="{ active: c.value === track.color }" :style="{ background: c.value }" :title="c.name"
                      @click="store.setTrackProp(track.id, 'color', c.value)"
                    />
                  </div>
                </q-item-section>
              </q-item>
              <q-separator dark />
              <q-item v-close-popup clickable @click="store.removeTrack(track.id)"><q-item-section class="text-negative">Remover faixa</q-item-section></q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </div>

      <div class="row q-gutter-x-xs q-mt-xs">
        <q-btn
          dense unelevated size="sm" label="Mudo" class="col"
          :color="track.mute ? 'warning' : 'grey-9'" :text-color="track.mute ? 'black' : 'grey-4'"
          @click="store.setTrackProp(track.id, 'mute', !track.mute)"
        />
        <q-btn
          dense unelevated size="sm" label="Solo" class="col"
          :color="track.solo ? 'primary' : 'grey-9'" :text-color="track.solo ? 'white' : 'grey-4'"
          @click="store.setTrackProp(track.id, 'solo', !track.solo)"
        />
      </div>

      <div class="slider-row" :title="`Ganho: ${track.gain.toFixed(1)} dB`">
        <q-icon name="volume_down" size="14px" />
        <q-slider
          :model-value="track.gain" :min="-36" :max="36" :step="0.5" dense dark color="grey-5"
          @update:model-value="v => store.setTrackProp(track.id, 'gain', v)"
          @dblclick="store.setTrackProp(track.id, 'gain', 0)"
        />
        <span class="mono val">{{ track.gain > 0 ? '+' : '' }}{{ track.gain.toFixed(1) }}</span>
      </div>
      <div class="slider-row" :title="`Pan: ${panLabel}`">
        <span class="lr">E</span>
        <q-slider
          :model-value="track.pan" :min="-1" :max="1" :step="0.02" dense dark color="grey-5"
          @update:model-value="v => store.setTrackProp(track.id, 'pan', v)"
          @dblclick="store.setTrackProp(track.id, 'pan', 0)"
        />
        <span class="lr">D</span>
      </div>

      <div v-if="track.kind === 'midi'" class="row items-center no-wrap q-gutter-x-xs midi-row">
        <q-select
          :model-value="track.drum ? 128 : Math.floor(track.program / 8) * 8" :options="INSTRUMENTS"
          emit-value map-options dense dark options-dense borderless class="col instrument"
          @update:model-value="v => store.setInstrument(track.id, v)"
        />
        <q-btn flat dense size="sm" icon="mdi-piano" color="positive" title="Abrir no piano roll (F7)" @click="ui.pianoRoll = track.id" />
      </div>
      <div v-else class="track-info" @pointerdown="select">
        {{ track.channels.length > 1 ? 'Estéreo' : 'Mono' }}, {{ store.rate }} Hz · 32-bit float
      </div>
    </div>
    <div class="track-wave">
      <WaveformCanvas :track="track" :height="height" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { INSTRUMENTS } from 'src/audio/synth'
import { TRACK_COLORS, rgba, shade } from 'src/audio/colors'
import WaveformCanvas from './WaveformCanvas.vue'

const props = defineProps({
  track: { type: Object, required: true },
  height: { type: Number, default: 140 },
  headerWidth: { type: Number, default: 190 }
})

const store = useProjectStore()
const ui = useUiStore()
const activeFx = computed(() => props.track.effects.some(e => e.enabled))
const isRec = computed(() => !!store.recTake?.ids.includes(props.track.id))
const colorName = computed(() => TRACK_COLORS.find(c => c.value === props.track.color)?.name ?? props.track.color)
// A cor da faixa vira variáveis CSS usadas no cabeçalho.
const colorVars = computed(() => {
  const c = props.track.color || '#3d7bf5'
  return { '--tc': c, '--tc-soft': rgba(c, 0.14), '--tc-icon': rgba(c, 0.22), '--tc-light': shade(c, 0.45) }
})

const panLabel = computed(() => {
  const p = props.track.pan
  if (Math.abs(p) < 0.01) return 'Centro'
  return `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? 'esquerda' : 'direita'}`
})

const select = e => store.selectTrack(props.track.id, e.ctrlKey || e.metaKey)
const selectWhole = () => {
  store.selectTrack(props.track.id)
  store.setSelection(props.track.offset, store.trackEnd(props.track))
}
</script>

<style scoped>
.track-row { display: flex; border-bottom: 1px solid var(--ed-border); }
.track-header {
  flex: none;
  padding: 4px 6px;
  background: var(--ed-panel);
  border-right: 1px solid var(--ed-border);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.track-header { border-left: 4px solid var(--tc); }
.track-row.selected .track-header { background: linear-gradient(90deg, var(--tc-soft), #2b1f42 70%); box-shadow: inset 0 0 0 1px var(--tc-soft); }
.track-row.recording .track-header { border-left-color: #e5484d; box-shadow: inset 0 0 0 1px rgba(229,72,77,0.6); }
.rec-chip { color: #fff; background: #e5484d; border-radius: 3px; padding: 0 4px; font-size: 9.5px; margin-right: 4px; animation: recblink 1s steps(2, start) infinite; }
@keyframes recblink { to { opacity: 0.45; } }
.track-icon {
  width: 24px; height: 24px; flex: none; border: none; border-radius: 6px; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--tc-icon); color: var(--tc-light);
}
.track-icon:hover { outline: 1px solid var(--tc); }
.swatch { width: 22px; height: 22px; border-radius: 5px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.swatch.active, .swatch:hover { border-color: #fff; }
.track-name { font-weight: 500; cursor: pointer; padding: 2px 4px; border-radius: 3px; }
.track-name:hover { background: rgba(255,255,255,0.06); }
.track-wave { flex: 1; min-width: 0; }
.fx-badge { font-size: 8px; padding: 1px 3px; min-height: 0; top: -2px; right: -4px; }
.slider-row { display: flex; align-items: center; gap: 6px; color: var(--ed-text-dim); }
.slider-row .q-slider { flex: 1; }
.val { width: 34px; text-align: right; font-size: 11px; }
.lr { width: 10px; font-size: 10px; text-align: center; }
.midi-row { margin-top: auto; }
.instrument { font-size: 11px; }
.instrument :deep(.q-field__control), .instrument :deep(.q-field__native) { min-height: 24px; padding: 0; }
.track-info { margin-top: auto; color: var(--ed-text-dim); font-size: 10.5px; }
</style>
