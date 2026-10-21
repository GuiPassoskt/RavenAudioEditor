<template>
  <div class="strip column no-wrap" :class="{ selected: track?.selected, master: isMaster }" :style="colorVars">
    <div class="strip-name ellipsis" :title="name" @click="onSelect">{{ name }}</div>

    <!-- Slots de efeito (inserts) -->
    <div class="inserts" :title="'Efeitos em tempo real de ' + name" @click="ui.fxTarget = targetId">
      <div v-for="fx in effects.slice(0, 4)" :key="fx.uid" class="insert ellipsis" :class="{ off: !fx.enabled }">
        <span class="dot" />{{ fxName(fx) }}
      </div>
      <div v-if="effects.length > 4" class="insert more">+{{ effects.length - 4 }}</div>
      <div v-if="!effects.length" class="insert add"><q-icon name="add" size="12px" /> Efeitos</div>
    </div>

    <div v-if="!isMaster" class="pan" :title="`Pan: ${panLabel}`">
      <q-slider
        :model-value="track.pan" :min="-1" :max="1" :step="0.02" dense dark color="grey-5"
        @update:model-value="v => store.setTrackProp(track.id, 'pan', v)" @dblclick="store.setTrackProp(track.id, 'pan', 0)"
      />
      <div class="pan-label mono">{{ panLabel }}</div>
    </div>
    <div v-else class="pan pan-label mono">estÃ©reo</div>

    <div class="fader-area row no-wrap col">
      <div class="scale mono">
        <span v-for="d in SCALE" :key="d" :style="{ bottom: faderPct(d) + '%' }">{{ d > 0 ? '+' + d : d }}</span>
      </div>
      <q-slider
        :model-value="gain" vertical reverse :min="GAIN_MIN" :max="GAIN_MAX" :step="0.1" dark
        :color="isMaster ? 'accent' : 'primary'" class="fader" track-size="4px" thumb-size="18px"
        @update:model-value="setGain" @dblclick="setGain(0)"
      />
      <div class="vmeter row no-wrap">
        <div v-for="(l, i) in levels" :key="i" class="vbar">
          <div class="vfill" :style="{ height: meterPct(l) + '%' }" />
          <div class="vhold" :class="{ clip: holds[i] >= 1 }" :style="{ bottom: meterPct(holds[i]) + '%' }" />
        </div>
      </div>
    </div>

    <div class="gain-value mono">{{ gain > 0 ? '+' : '' }}{{ gain.toFixed(1) }} dB</div>

    <div v-if="!isMaster" class="row no-wrap q-gutter-x-xs q-px-xs q-pb-xs">
      <q-btn
        dense unelevated size="sm" label="M" class="col" title="Mudo"
        :color="track.mute ? 'warning' : 'grey-9'" :text-color="track.mute ? 'black' : 'grey-4'"
        @click="store.setTrackProp(track.id, 'mute', !track.mute)"
      />
      <q-btn
        dense unelevated size="sm" label="S" class="col" title="Solo"
        :color="track.solo ? 'primary' : 'grey-9'" :text-color="track.solo ? 'white' : 'grey-4'"
        @click="store.setTrackProp(track.id, 'solo', !track.solo)"
      />
    </div>
    <div v-else class="master-label">MASTER</div>
  </div>
</template>

<script setup>
// Uma coluna da mesa de som, como o MixerTrackCluster do Audacity (src/MixerBoard.cpp):
// nome, pan, fader de volume, medidor e mudo/solo. Aqui tambÃ©m mostra os
// inserts (efeitos em tempo real) da faixa.

import { computed, reactive, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { realtimeDef } from 'src/audio/realtime'
import { rgba, textOn } from 'src/audio/colors'

const props = defineProps({
  track: { type: Object, default: null }, // null = master
  levels: { type: Array, default: () => [0, 0] }
})

const GAIN_MIN = -36
const GAIN_MAX = 12
const SCALE = [12, 6, 0, -6, -12, -24, -36]
const METER_MIN_DB = -60

const store = useProjectStore()
const ui = useUiStore()

const isMaster = computed(() => !props.track)
const targetId = computed(() => (isMaster.value ? 'master' : props.track.id))
const name = computed(() => (isMaster.value ? 'Master' : props.track.name))
const effects = computed(() => (isMaster.value ? store.master.effects : props.track.effects))
const gain = computed(() => (isMaster.value ? store.master.gain : props.track.gain))
const colorVars = computed(() => {
  const c = isMaster.value ? '#ff7a1a' : (props.track.color || '#3d7bf5')
  return { '--tc': c, '--tc-text': textOn(c), '--tc-soft': rgba(c, 0.10) }
})

const panLabel = computed(() => {
  const p = props.track?.pan ?? 0
  if (Math.abs(p) < 0.01) return 'C'
  return `${p < 0 ? 'E' : 'D'} ${Math.round(Math.abs(p) * 100)}`
})

const fxName = fx => realtimeDef(fx.type)?.name ?? fx.type
const faderPct = d => (d - GAIN_MIN) / (GAIN_MAX - GAIN_MIN) * 100
const meterPct = v => (v > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(v) - METER_MIN_DB) / -METER_MIN_DB * 100)) : 0)

function setGain (v) {
  const value = Math.max(GAIN_MIN, Math.min(GAIN_MAX, v))
  if (isMaster.value) store.setMasterGain(value)
  else store.setTrackProp(props.track.id, 'gain', value)
}

function onSelect (e) {
  if (!isMaster.value) store.selectTrack(props.track.id, e.ctrlKey || e.metaKey)
}

// RetenÃ§Ã£o de pico por 1,5 s.
const holds = reactive([0, 0])
const holdTime = [0, 0]
watch(() => props.levels, lv => {
  const now = performance.now()
  lv.forEach((v, i) => {
    if (v >= holds[i] || now - holdTime[i] > 1500) { holds[i] = v; holdTime[i] = now }
  })
})
</script>

<style scoped>
.strip {
  width: 112px; flex: none; height: 100%;
  background: var(--ed-panel); border: 1px solid var(--ed-border); border-radius: 6px;
}
.strip { background: linear-gradient(180deg, var(--tc-soft), var(--ed-panel) 45%); }
.strip.selected { border-color: var(--tc); box-shadow: 0 0 0 1px var(--tc); }
.strip.master { background: #241a36; border-color: #6b3a2a; }
.strip-name { background: var(--tc); color: var(--tc-text); border-radius: 5px 5px 0 0; padding: 5px 8px; font-size: 12px; font-weight: 500; text-align: center; border-bottom: 1px solid var(--ed-border); cursor: pointer; }
.inserts { margin: 4px; min-height: 58px; background: #0b0812; border-radius: 4px; padding: 3px; cursor: pointer; }
.inserts:hover { outline: 1px solid var(--q-primary); }
.insert { font-size: 10.5px; line-height: 13px; padding: 0 3px; color: #d4c8ec; }
.insert .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--q-positive); margin-right: 4px; }
.insert.off { opacity: 0.45; }
.insert.off .dot { background: #666; }
.insert.add, .insert.more { color: var(--ed-text-dim); text-align: center; }
.pan { padding: 0 8px; }
.pan-label { font-size: 10px; color: var(--ed-text-dim); text-align: center; height: 26px; line-height: 12px; }
.fader-area { padding: 6px 4px 2px; min-height: 0; justify-content: center; gap: 2px; }
.scale { position: relative; width: 22px; font-size: 8.5px; color: var(--ed-text-dim); margin: 9px 0; }
.scale span { position: absolute; right: 2px; transform: translateY(50%); }
.fader { height: auto; min-height: 0; }
.vmeter { gap: 2px; margin: 9px 0 9px 4px; }
.vbar { position: relative; width: 6px; height: 100%; background: #0b0812; border-radius: 2px; overflow: hidden; }
.vfill { position: absolute; bottom: 0; width: 100%; background: linear-gradient(0deg, #21ba45 0%, #21ba45 60%, #f2c037 80%, #e5484d 100%); background-size: 100% 100%; }
.vhold { position: absolute; width: 100%; height: 2px; background: #efe9fb; }
.vhold.clip { background: #e5484d; }
.gain-value { text-align: center; font-size: 11px; color: #c9b3ff; padding: 2px 0 4px; }
.master-label { text-align: center; font-size: 10px; letter-spacing: 2px; color: var(--q-accent); padding-bottom: 6px; }
</style>
