<template>
  <q-dialog :model-value="!!ui.effect" @update:model-value="v => !v && close()">
    <q-card v-if="ui.effect" dark class="effect-card">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ title }}</div>
        <q-space />
        <q-btn v-close-popup flat round dense icon="close" />
      </q-card-section>
      <q-card-section class="text-caption text-grey-6 q-pt-xs">
        Baseado em <span class="mono">{{ ui.effect.def.source }}</span>
      </q-card-section>

      <q-card-section class="q-gutter-y-md">
        <template v-for="p in visibleParams" :key="p.key">
          <div v-if="p.type === 'number'">
            <div class="row items-center justify-between">
              <span>{{ p.label }}</span>
              <q-input
                v-model.number="params[p.key]" type="number" dense dark outlined
                :min="p.min" :max="p.max" :step="p.step" :suffix="p.unit" style="width: 140px"
              />
            </div>
            <q-slider v-model="params[p.key]" :min="p.min" :max="Math.min(p.max, sliderMax(p))" :step="p.step" dark dense color="primary" />
          </div>
          <q-select
            v-else-if="p.type === 'select'" v-model="params[p.key]" :options="p.options"
            :label="p.label" emit-value map-options dense dark outlined
          />
          <q-input v-else-if="p.type === 'text'" v-model="params[p.key]" :label="p.label" dense dark outlined />
          <q-toggle v-else-if="p.type === 'bool'" v-model="params[p.key]" :label="p.label" dark />
        </template>
        <div v-if="description" class="text-caption text-info">{{ description }}</div>
        <div v-if="ui.effect.kind === 'generate'" class="text-caption text-grey-6">
          {{ generateHint }}
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-if="ui.effect.kind === 'effect'" flat icon="play_arrow" label="Prévia" color="grey-4" @click="preview" />
        <q-btn flat label="Padrões" color="grey-5" @click="resetDefaults" />
        <q-space />
        <q-btn v-close-popup flat label="Cancelar" color="grey-5" />
        <q-btn unelevated label="Aplicar" color="primary" @click="apply" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
// Diálogo genérico de efeito/gerador montado a partir do esquema de parâmetros
// (equivalente ao EffectUI + ShuttleGui do Audacity). Lembra os últimos valores
// usados, como as "configurações atuais" do Audacity.

import { computed, reactive, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { defaultsOf } from 'src/audio/effects'
import { engine } from 'src/audio/engine'
import { guard } from 'src/composables/commands'

const PREVIEW_SECONDS = 6 // o Audacity usa 6 s por padrão (EffectPreview.cpp)

const store = useProjectStore()
const ui = useUiStore()
const params = reactive({})

const title = computed(() => ui.effect?.def.name.replace('…', ''))
const visibleParams = computed(() => {
  const def = ui.effect?.def
  if (!def) return []
  // Gerando sobre uma seleção, a duração vem da própria seleção.
  if (ui.effect.kind === 'generate' && replacing.value) return def.params.filter(p => p.key !== 'duration')
  return def.params
})
const replacing = computed(() => store.hasSelection && store.selectedTracks.some(t => t.kind !== 'midi'))
const description = computed(() => ui.effect?.def.describe?.(params) ?? '')
const generateHint = computed(() => replacing.value
  ? 'O áudio gerado substituirá a seleção atual.'
  : store.selectedTracks.length ? 'O áudio será inserido no cursor das faixas selecionadas.' : 'Uma nova faixa será criada no cursor.')

const storageKey = id => `rea.effect.${id}`
const sliderMax = p => (p.key === 'duration' ? 60 : p.max)

function regionForPrepare () {
  const t = store.selectedTracks.find(x => x.kind !== 'midi')
  return t ? store.regionChannels(t) : null
}

watch(() => ui.effect, eff => {
  for (const k of Object.keys(params)) delete params[k]
  if (!eff) return
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem(storageKey(eff.def.id)) || '{}') } catch { /* sem storage */ }
  Object.assign(params, defaultsOf(eff.def), saved)
  const region = eff.def.prepare && regionForPrepare()
  if (region) Object.assign(params, eff.def.prepare(region))
})

function resetDefaults () {
  Object.assign(params, defaultsOf(ui.effect.def))
  const region = ui.effect.def.prepare && regionForPrepare()
  if (region) Object.assign(params, ui.effect.def.prepare(region))
}

function close () {
  engine.stopPreview()
  ui.effect = null
}

function preview () {
  guard(() => {
    const t = store.requireAudioTargets()[0]
    const [s0, s1] = store.regionOf(t)
    const end = Math.min(s1, s0 + PREVIEW_SECONDS * store.rate)
    const region = t.channels.map(ch => ch.slice(s0, end))
    const out = ui.effect.def.process(region, { ...params }, { rate: store.rate })
    return engine.playPreview(out, store.rate)
  })
}

async function apply () {
  const { def, kind } = ui.effect
  const values = { ...params }
  try {
    const persisted = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith('_') && k !== 'amp'))
    localStorage.setItem(storageKey(def.id), JSON.stringify(persisted))
  } catch { /* storage indisponível */ }
  engine.stopPreview()
  const ok = await guard(() => {
    if (kind === 'effect') store.applyEffect(def, values)
    else store.generate(def, values)
    return true
  }, { loading: true })
  if (ok) ui.effect = null
}
</script>

<style scoped>
.effect-card { width: 460px; max-width: 95vw; }
</style>
