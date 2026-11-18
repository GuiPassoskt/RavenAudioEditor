<template>
  <q-dialog :model-value="ui.pluginEffect" @update:model-value="v => !v && close()">
    <q-card dark class="plugin-card column no-wrap">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ instance?.name ?? 'Plugin' }}</div>
        <q-space />
        <q-btn flat round dense icon="close" @click="close" />
      </q-card-section>

      <q-card-section class="q-gutter-y-sm">
        <div class="row items-center no-wrap q-gutter-x-sm">
          <q-select
            :model-value="instance?.pluginId ?? null" :options="filteredOptions" label="Plugin"
            class="col" emit-value map-options use-input input-debounce="0" dense dark outlined
            :loading="loadingList" :disable="!!scan" @filter="filterPlugins" @update:model-value="loadPlugin"
          >
            <template #no-option>
              <q-item><q-item-section class="text-grey-6">Nenhum plugin encontrado</q-item-section></q-item>
            </template>
          </q-select>
          <q-btn flat dense icon="travel_explore" color="grey-4" :loading="!!scan" @click="rescan(false)">
            <q-tooltip>Procurar plugins instalados</q-tooltip>
          </q-btn>
        </div>
        <template v-if="scan">
          <q-linear-progress :value="scan.progress" color="primary" />
          <div class="text-caption text-grey-5 ellipsis">Procurando {{ scan.format }}: {{ scan.file }}</div>
        </template>
        <div v-else-if="!loadingList && !options.length && !engineError" class="text-caption text-grey-6">
          Nenhum plugin de efeito na lista. Clique em procurar.
        </div>
        <div v-if="engineError" class="text-caption text-negative">{{ engineError }}</div>
      </q-card-section>

      <template v-if="instance">
        <q-card-section class="row items-center q-py-none">
          <span class="text-caption text-grey-6">
            {{ instance.params.length }} parâmetros<span v-if="instance.latency"> · latência de {{ instance.latency }} amostras</span>
          </span>
          <q-space />
          <q-btn flat dense no-caps icon="open_in_new" label="Interface do plugin" color="grey-4" @click="openEditor" />
        </q-card-section>

        <q-card-section v-if="instance.params.length > 8" class="q-py-xs">
          <q-input v-model="paramFilter" dense dark outlined clearable placeholder="Filtrar parâmetros" />
        </q-card-section>

        <q-card-section class="col param-list">
          <PluginParamList :params="visibleParams" @set="setParam" />
          <div v-if="!instance.params.length" class="text-caption text-grey-6">
            Este plugin não expõe parâmetros. Use a interface do plugin.
          </div>
        </q-card-section>
      </template>

      <q-card-actions align="right">
        <q-btn flat icon="play_arrow" label="Prévia" color="grey-4" :disable="!instance" @click="preview" />
        <q-space />
        <q-btn flat label="Cancelar" color="grey-5" @click="close" />
        <q-btn unelevated label="Aplicar" color="primary" :disable="!instance" @click="apply" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
// Aplica um plugin VST3/LV2 instalado na seleção, pelo motor nativo (raven-engine).
// Fase 1 de docs/INTEGRACAO-PLUGINS-NATIVOS.md: equivale ao "Efeito → Aplicar" do
// Audacity com um plugin de terceiros, sem processamento em tempo real.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { engine } from 'src/audio/engine'
import { nativePlugins } from 'src/audio/plugins'
import { guard, notifyError } from 'src/composables/commands'
import PluginParamList from 'components/PluginParamList.vue'

const PREVIEW_SECONDS = 6 // igual ao EffectDialog
const LAST_PLUGIN_KEY = 'rea.plugin.last'

const store = useProjectStore()
const ui = useUiStore()

const plugins = ref([])
const loadingList = ref(false)
const engineError = ref('')
const filter = ref('')
const scan = ref(null) // { format, file, progress } enquanto procura
const instance = ref(null) // { instanceId, pluginId, name, params, latency }
const paramFilter = ref('')

const options = computed(() => plugins.value
  .filter(p => !p.isInstrument)
  .map(p => ({ label: `${p.name} — ${p.vendor || 'desconhecido'} (${p.format})`, value: p.id }))
  .sort((a, b) => a.label.localeCompare(b.label)))
const filteredOptions = computed(() => {
  const f = filter.value.toLowerCase()
  return f ? options.value.filter(o => o.label.toLowerCase().includes(f)) : options.value
})
const visibleParams = computed(() => {
  const f = (paramFilter.value ?? '').toLowerCase()
  const params = instance.value?.params ?? []
  return f ? params.filter(p => p.name.toLowerCase().includes(f)) : params
})


function filterPlugins (val, update) {
  update(() => { filter.value = val })
}

let offEvents = () => {}
onMounted(() => {
  offEvents = nativePlugins.onEvent((name, msg) => {
    if (name === 'scan.progress' && scan.value) {
      scan.value = { format: msg.format, file: msg.file, progress: msg.progress }
    } else if (name === 'fx.paramChanged' && msg.instanceId === instance.value?.instanceId) {
      // Mexeram na janela do plugin: atualiza os controles daqui.
      const p = instance.value.params.find(x => x.index === msg.index)
      if (p) Object.assign(p, { value: msg.value, text: msg.text })
    } else if (name === 'engine.exit' && instance.value) {
      instance.value = null
      engineError.value = 'O motor de áudio foi reiniciado (um plugin pode ter travado). Escolha o plugin de novo.'
    }
  })
})
onBeforeUnmount(() => {
  offEvents()
  destroyInstance()
})

watch(() => ui.pluginEffect, open => (open ? onOpen() : destroyInstance()))

async function onOpen () {
  engineError.value = ''
  paramFilter.value = ''
  loadingList.value = true
  try {
    plugins.value = await nativePlugins.list()
  } catch (e) {
    engineError.value = e.message
    return
  } finally {
    loadingList.value = false
  }
  // Primeira vez: a lista ainda não existe.
  if (!plugins.value.length) await rescan(false)

  let last = null
  try { last = localStorage.getItem(LAST_PLUGIN_KEY) } catch { /* sem storage */ }
  if (last && plugins.value.some(p => p.id === last)) await loadPlugin(last)
}

async function rescan (full) {
  scan.value = { format: '', file: '', progress: 0 }
  engineError.value = ''
  try {
    plugins.value = await nativePlugins.scan({ full })
  } catch (e) {
    engineError.value = e.message
  } finally {
    scan.value = null
  }
}

async function destroyInstance () {
  const inst = instance.value
  instance.value = null
  if (inst) await nativePlugins.destroy(inst.instanceId).catch(() => {})
}

async function loadPlugin (pluginId) {
  if (!pluginId || pluginId === instance.value?.pluginId) return
  await destroyInstance()
  engineError.value = ''
  const ok = await guard(async () => {
    instance.value = await nativePlugins.create(pluginId, store.rate)
    return true
  }, { loading: true })
  if (ok) {
    try { localStorage.setItem(LAST_PLUGIN_KEY, pluginId) } catch { /* sem storage */ }
  }
}

async function setParam (p, value) {
  p.value = value
  try {
    const r = await nativePlugins.setParam(instance.value.instanceId, p.index, value)
    Object.assign(p, r)
  } catch (e) {
    notifyError(e)
  }
}

function openEditor () {
  guard(() => nativePlugins.openEditor(instance.value.instanceId))
}

// Mesmo formato dos efeitos internos, para reaproveitar store.applyEffect (e o undo).
function effectDef (inst) {
  return {
    name: inst.name,
    process: (region, _params, { rate }) => nativePlugins.process(inst.instanceId, region, rate)
  }
}

function preview () {
  guard(async () => {
    const t = store.requireAudioTargets()[0]
    const [s0, s1] = store.regionOf(t)
    const end = Math.min(s1, s0 + PREVIEW_SECONDS * store.rate)
    const region = t.channels.map(ch => ch.slice(s0, end))
    const out = await effectDef(instance.value).process(region, {}, { rate: store.rate })
    return engine.playPreview(out, store.rate)
  }, { loading: true })
}

async function apply () {
  engine.stopPreview()
  const ok = await guard(async () => {
    await store.applyEffect(effectDef(instance.value), {})
    return true
  }, { loading: true })
  if (ok) close()
}

function close () {
  engine.stopPreview()
  ui.pluginEffect = false
}
</script>

<style scoped>
.plugin-card { width: 520px; max-width: 95vw; max-height: 85vh; }
.param-list { overflow-y: auto; min-height: 0; }
</style>
