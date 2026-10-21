<template>
  <div class="meter" :title="title">
    <q-icon :name="icon" size="16px" :color="iconColor" />
    <div class="bars">
      <div v-for="(lvl, i) in shown" :key="i" class="bar">
        <div class="fill" :style="{ width: pct(lvl) + '%' }" />
        <div class="hold" :style="{ left: pct(holds[i]) + '%' }" :class="{ clip: holds[i] >= 1 }" />
      </div>
      <div class="scale mono"><span v-for="d in [-60, -48, -36, -24, -12, 0]" :key="d" :style="{ left: pctDb(d) + '%' }">{{ d }}</span></div>
    </div>
  </div>
</template>

<script setup>
// Medidor de nível de pico com retenção (como o MeterPanel do Audacity, src/widgets/MeterPanel.cpp).
import { computed, reactive, watch } from 'vue'

const props = defineProps({
  levels: { type: Array, required: true }, // picos lineares 0..1 por canal
  icon: { type: String, default: 'volume_up' },
  iconColor: { type: String, default: 'grey-5' },
  title: { type: String, default: '' }
})

const MIN_DB = -60
const holds = reactive([0, 0])
const holdTime = [0, 0]

const shown = computed(() => props.levels)
const pctDb = db => Math.max(0, Math.min(100, (db - MIN_DB) / -MIN_DB * 100))
const pct = v => (v > 0 ? pctDb(20 * Math.log10(v)) : 0)

watch(() => props.levels, lv => {
  const now = performance.now()
  lv.forEach((v, i) => {
    if (v >= holds[i] || now - holdTime[i] > 1500) {
      holds[i] = v
      holdTime[i] = now
    }
  })
})
</script>

<style scoped>
.meter { display: flex; align-items: center; gap: 6px; width: 220px; }
.bars { flex: 1; position: relative; padding-bottom: 10px; }
.bar { position: relative; height: 6px; margin: 2px 0; background: #0b0812; border-radius: 2px; overflow: hidden; }
.fill { height: 100%; background: linear-gradient(90deg, #21ba45 0%, #21ba45 70%, #f2c037 85%, #e5484d 100%); background-size: 220px 100%; }
.hold { position: absolute; top: 0; width: 2px; height: 100%; background: #efe9fb; }
.hold.clip { background: #e5484d; }
.scale { position: absolute; left: 0; right: 0; bottom: -2px; height: 10px; font-size: 8px; color: var(--ed-text-dim); }
.scale span { position: absolute; transform: translateX(-50%); }
</style>
