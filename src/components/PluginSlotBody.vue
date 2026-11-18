<template>
  <div class="slot-body">
    <div v-if="!available" class="text-caption text-grey-6 q-py-xs">
      Plugins só tocam no app desktop. Aqui no navegador este efeito passa o som sem alteração.
    </div>
    <div v-else-if="error" class="text-caption text-negative q-py-xs">{{ error }} O som passa sem este efeito.</div>
    <template v-else-if="info">
      <div class="row items-center no-wrap q-pt-xs">
        <span class="col text-caption text-grey-6 ellipsis">
          {{ fx.plugin.vendor }} · {{ fx.plugin.format }}
          <span v-if="info.latency" :title="`${info.latency} amostras, compensadas nas outras faixas`"> · latência {{ latencyMs }} ms</span>
        </span>
        <q-btn
          flat dense no-caps size="sm" icon="open_in_new" label="Interface" color="grey-4"
          title="Abrir a janela do plugin" @click="openEditor"
        />
      </div>
      <q-expansion-item
        v-if="info.params.length" v-model="paramsOpen" dense dark switch-toggle-side
        :label="`Parâmetros (${info.params.length})`" header-class="text-caption q-px-none params-header"
      >
        <q-input
          v-if="info.params.length > 8" v-model="filter" dense dark outlined clearable
          placeholder="Filtrar parâmetros" class="q-mb-sm"
        />
        <PluginParamList :params="visibleParams" @set="setParam" />
      </q-expansion-item>
    </template>
    <div v-else class="row justify-center q-pa-xs"><q-spinner size="18px" color="grey-5" /></div>
  </div>
</template>

<script setup>
// Corpo do cartão de um plugin VST3/LV2 numa cadeia em tempo real (Fase 3):
// abre a janela nativa e mostra os parâmetros genéricos. O ajuste fica guardado
// no projeto pelo aviso "chain.pluginState" do motor (MainLayout.vue).

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { engineReady } from 'src/audio/engine'
import { chainPlugin } from 'src/audio/engine-native'
import { nativePlugins } from 'src/audio/plugins'
import { notifyError } from 'src/composables/commands'
import PluginParamList from 'components/PluginParamList.vue'

const props = defineProps({ fx: { type: Object, required: true } })

const store = useProjectStore()
const available = ref(true)
const info = ref(null)
const error = ref('')
const filter = ref('')
const paramsOpen = ref(false)

const latencyMs = computed(() => ((info.value?.latency ?? 0) / store.rate * 1000).toFixed(1))
const visibleParams = computed(() => {
  const f = (filter.value ?? '').toLowerCase()
  const params = info.value?.params ?? []
  return f ? params.filter(p => p.name.toLowerCase().includes(f)) : params
})

const sameSlot = msg => String(msg.uid) === String(props.fx.uid)

async function load () {
  if (await engineReady !== 'native') {
    available.value = false
    return
  }
  try {
    await store.syncEngine()
    info.value = await chainPlugin.info(props.fx.uid)
    error.value = ''
  } catch (e) {
    error.value = e.message
  }
}

let offEvents = () => {}
onMounted(() => {
  load()
  offEvents = nativePlugins.onEvent((name, msg) => {
    if (!sameSlot(msg)) return
    if (name === 'chain.paramChanged') {
      const p = info.value?.params.find(x => x.index === msg.index)
      if (p) Object.assign(p, { value: msg.value, text: msg.text })
    } else if (name === 'chain.pluginError') {
      error.value = msg.message
    }
  })
})
onBeforeUnmount(() => offEvents())

// Desfazer/refazer troca o estado do plugin: relê os valores.
watch(() => props.fx.stateVersion, load)

function openEditor () {
  chainPlugin.openEditor(props.fx.uid).catch(notifyError)
}

async function setParam (p, value) {
  p.value = value
  try {
    await chainPlugin.setParam(props.fx.uid, p.index, value)
  } catch (e) {
    notifyError(e)
  }
}
</script>

<style scoped>
.slot-body :deep(.params-header) { min-height: 28px; }
</style>
