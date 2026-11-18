<template>
  <q-dialog v-model="ui.audioDevicesOpen">
    <q-card dark class="devices-card">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Dispositivos de áudio</div>
        <q-space />
        <q-btn v-close-popup flat round dense icon="close" />
      </q-card-section>

      <q-card-section v-if="current" class="text-caption text-grey-5 q-pb-none">
        Em uso: {{ current.type }} · {{ current.device || 'nenhum dispositivo' }}
        <span v-if="current.sampleRate"> · {{ current.sampleRate }} Hz · buffer de {{ current.bufferSize }}
          · latência de {{ current.latencyMs.toFixed(1) }} ms</span>
      </q-card-section>

      <q-card-section v-if="loading" class="row justify-center"><q-spinner color="primary" size="32px" /></q-card-section>

      <q-card-section v-else-if="form" class="q-gutter-y-md">
        <q-select
          v-model="form.type" :options="types.map(t => t.name)" label="Driver"
          dense dark outlined @update:model-value="onTypeChange"
        />
        <q-select v-model="form.output" :options="selectedType?.outputs ?? []" label="Saída" dense dark outlined />
        <q-select
          v-model="form.input" :options="inputOptions" label="Entrada (gravação)"
          emit-value map-options dense dark outlined
        />
        <div class="row q-col-gutter-sm">
          <q-select
            v-model="form.sampleRate" :options="current?.sampleRates ?? []" label="Taxa do dispositivo (Hz)"
            class="col-6" dense dark outlined :disable="!sameDevice"
          />
          <q-select
            v-model="form.bufferSize" :options="current?.bufferSizes ?? []" label="Buffer (amostras)"
            class="col-6" dense dark outlined :disable="!sameDevice"
          />
        </div>
        <div class="text-caption text-grey-6">
          O projeto é mixado na taxa dele ({{ store.rate }} Hz) e convertido para a taxa do dispositivo.
          Buffers menores dão menos latência, mas pedem mais do processador.
          <template v-if="!sameDevice">Taxa e buffer ficam disponíveis depois de aplicar o novo dispositivo.</template>
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-close-popup flat label="Fechar" color="grey-5" />
        <q-btn unelevated label="Aplicar" color="primary" :loading="applying" :disable="!form || loading" @click="apply" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
// Escolha do driver (Windows Audio, ASIO…), da saída, da entrada, da taxa e do
// buffer do motor de áudio nativo. O motor salva a escolha entre sessões.

import { computed, ref, watch } from 'vue'
import { Notify } from 'quasar'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { audioDevices, setAudioDevice } from 'src/audio/engine-native'
import { notifyError } from 'src/composables/commands'

const store = useProjectStore()
const ui = useUiStore()

const types = ref([])
const current = ref(null)
const form = ref(null)
const loading = ref(false)
const applying = ref(false)

const selectedType = computed(() => types.value.find(t => t.name === form.value?.type))
const inputOptions = computed(() => [
  { label: 'Padrão do sistema', value: '' },
  ...(selectedType.value?.inputs ?? []).map(name => ({ label: name, value: name }))
])
// Taxa e buffer só valem para o dispositivo aberto agora.
const sameDevice = computed(() => form.value && current.value &&
  form.value.type === current.value.type && form.value.output === current.value.output)

function load (result) {
  types.value = result.types
  current.value = result.current
  const c = result.current
  form.value = { type: c.type, output: c.output, input: c.input, sampleRate: c.sampleRate, bufferSize: c.bufferSize }
}

watch(() => ui.audioDevicesOpen, async open => {
  if (!open) return
  loading.value = true
  try {
    load(await audioDevices())
  } catch (e) {
    notifyError(e)
  } finally {
    loading.value = false
  }
})

function onTypeChange () {
  const t = selectedType.value
  form.value.output = t?.outputs[0] ?? ''
  form.value.input = ''
}

async function apply () {
  applying.value = true
  try {
    const settings = { ...form.value }
    if (!sameDevice.value) {
      delete settings.sampleRate
      delete settings.bufferSize
    }
    load(await setAudioDevice(settings))
    Notify.create({ type: 'positive', message: `Áudio: ${current.value.type} · ${current.value.device}`, position: 'bottom', timeout: 2000 })
  } catch (e) {
    notifyError(e)
  } finally {
    applying.value = false
  }
}
</script>

<style scoped>
.devices-card { width: 520px; max-width: 95vw; }
</style>
