<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)">
    <q-card dark class="picker-card">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Adicionar plugin</div>
        <q-space />
        <q-btn v-close-popup flat round dense icon="close" />
      </q-card-section>

      <q-card-section class="q-gutter-y-sm">
        <div class="row items-center no-wrap q-gutter-x-sm">
          <q-select
            v-model="selected" :options="filtered" label="Plugin de efeito (VST3 / LV2)" class="col"
            emit-value map-options use-input input-debounce="0" dense dark outlined
            :loading="loading" :disable="scanning" @filter="onFilter"
          >
            <template #no-option>
              <q-item><q-item-section class="text-grey-6">Nenhum plugin encontrado</q-item-section></q-item>
            </template>
          </q-select>
          <q-btn flat dense icon="travel_explore" color="grey-4" :loading="scanning" @click="scan">
            <q-tooltip>Procurar plugins instalados</q-tooltip>
          </q-btn>
        </div>
        <div class="text-caption text-grey-6">
          O plugin entra no fim da cadeia e processa ao tocar e ao exportar, sem alterar o áudio da faixa.
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-close-popup flat label="Cancelar" color="grey-5" />
        <q-btn unelevated label="Adicionar" color="primary" :disable="!selected" @click="pick" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
// Escolha de um plugin VST3/LV2 para uma cadeia de efeitos em tempo real (Fase 3).
// A lista é a mesma do diálogo Efeito → Plugin… (varredura do motor nativo).

import { computed, ref, watch } from 'vue'
import { nativePlugins } from 'src/audio/plugins'
import { notifyError } from 'src/composables/commands'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue', 'pick'])

const plugins = ref([])
const selected = ref(null)
const filter = ref('')
const loading = ref(false)
const scanning = ref(false)

const options = computed(() => plugins.value
  .filter(p => !p.isInstrument)
  .map(p => ({ label: `${p.name} — ${p.vendor || 'desconhecido'} (${p.format})`, value: p.id }))
  .sort((a, b) => a.label.localeCompare(b.label)))
const filtered = computed(() => {
  const f = filter.value.toLowerCase()
  return f ? options.value.filter(o => o.label.toLowerCase().includes(f)) : options.value
})

function onFilter (val, update) {
  update(() => { filter.value = val })
}

watch(() => props.modelValue, async open => {
  if (!open) return
  selected.value = null
  loading.value = true
  try {
    plugins.value = await nativePlugins.list()
    if (!plugins.value.length) await scan()
  } catch (e) {
    notifyError(e)
  } finally {
    loading.value = false
  }
})

async function scan () {
  scanning.value = true
  try {
    plugins.value = await nativePlugins.scan()
  } catch (e) {
    notifyError(e)
  } finally {
    scanning.value = false
  }
}

function pick () {
  emit('pick', plugins.value.find(p => p.id === selected.value))
  emit('update:modelValue', false)
}
</script>

<style scoped>
.picker-card { width: 480px; max-width: 95vw; }
</style>
