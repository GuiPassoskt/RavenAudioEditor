<template>
  <div class="q-gutter-y-sm">
    <div v-for="p in params" :key="p.index">
      <q-select
        v-if="p.options.length > 1" :model-value="optionValue(p)" :options="optionsOf(p)" :label="p.name"
        emit-value map-options dense dark outlined options-dense @update:model-value="v => emit('set', p, v)"
      />
      <q-toggle
        v-else-if="p.boolean" :model-value="p.value >= 0.5" :label="p.name" dense dark
        @update:model-value="v => emit('set', p, v ? 1 : 0)"
      />
      <template v-else>
        <div class="row items-center justify-between no-wrap text-caption">
          <span class="ellipsis">{{ p.name }}</span>
          <span class="mono text-grey-5 q-ml-sm">{{ p.text }} {{ p.label }}</span>
        </div>
        <q-slider
          :model-value="p.value" :min="0" :max="1" :step="stepOf(p)" dark dense color="primary"
          @update:model-value="v => emit('set', p, v)"
        />
      </template>
    </div>
  </div>
</template>

<script setup>
// Controles genéricos dos parâmetros de um plugin VST3/LV2 (valores normalizados
// 0..1, como o motor os descreve em describeParameter). Usado no diálogo
// Efeito → Plugin… e nos slots de plugin das cadeias em tempo real.

defineProps({ params: { type: Array, required: true } })
const emit = defineEmits(['set'])

const stepOf = p => (p.steps > 1 && p.steps <= 1000 ? 1 / (p.steps - 1) : 0)
const optionsOf = p => p.options.map((label, i) => ({ label, value: i / (p.options.length - 1) }))
const optionValue = p => Math.round(p.value * (p.options.length - 1)) / (p.options.length - 1)
</script>
