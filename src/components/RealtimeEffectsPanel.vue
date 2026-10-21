<template>
  <div class="fx-panel column no-wrap full-height">
    <div class="row items-center q-pa-sm no-wrap">
      <q-icon name="mdi-tune-vertical" class="q-mr-sm" />
      <div class="text-subtitle2 col">Efeitos em tempo real</div>
      <q-btn flat dense round icon="close" size="sm" @click="ui.fxTarget = null" />
    </div>
    <div class="q-px-sm q-pb-sm">
      <q-select
        :model-value="ui.fxTarget" :options="targetOptions" emit-value map-options
        dense dark outlined label="Aplicar em" @update:model-value="v => (ui.fxTarget = v)"
      />
    </div>
    <q-separator dark />

    <div v-if="!target" class="q-pa-md text-grey-6">A faixa não existe mais.</div>
    <div v-else class="col scroll q-pa-sm q-gutter-y-sm">
      <div v-if="!target.effects.length" class="empty text-grey-6">
        Nenhum efeito. Os efeitos aqui não alteram o áudio: são aplicados ao reproduzir e ao exportar,
        e podem ser ajustados, desligados ou reordenados a qualquer momento.
      </div>

      <div v-for="(fx, i) in target.effects" :key="fx.uid" class="fx-card" :class="{ off: !fx.enabled }">
        <div class="row items-center no-wrap fx-head">
          <q-toggle
            :model-value="fx.enabled" dense dark size="sm" color="positive"
            :title="fx.enabled ? 'Desligar (bypass)' : 'Ligar'" @update:model-value="store.toggleRealtimeEffect(ui.fxTarget, fx.uid)"
          />
          <div class="col q-ml-xs ellipsis fx-name" @click="toggleOpen(fx.uid)">{{ def(fx).name }}</div>
          <q-btn flat dense round size="xs" icon="arrow_upward" :disable="i === 0" title="Mover para cima" @click="store.moveRealtimeEffect(ui.fxTarget, fx.uid, -1)" />
          <q-btn flat dense round size="xs" icon="arrow_downward" :disable="i === target.effects.length - 1" title="Mover para baixo" @click="store.moveRealtimeEffect(ui.fxTarget, fx.uid, 1)" />
          <q-btn flat dense round size="xs" :icon="closed[fx.uid] ? 'expand_more' : 'expand_less'" @click="toggleOpen(fx.uid)" />
          <q-btn flat dense round size="xs" icon="delete" color="grey-5" title="Remover" @click="store.removeRealtimeEffect(ui.fxTarget, fx.uid)" />
        </div>
        <div v-if="!closed[fx.uid]" class="fx-body">
          <template v-for="p in def(fx).params" :key="p.key">
            <div v-if="p.type === 'number'" class="param">
              <div class="row justify-between text-caption">
                <span>{{ p.label }}</span>
                <span class="mono">{{ fmt(fx.params[p.key], p) }}</span>
              </div>
              <q-slider
                :model-value="fx.params[p.key]" :min="p.min" :max="p.max" :step="p.step" dense dark color="primary"
                @update:model-value="v => store.setRealtimeParam(ui.fxTarget, fx.uid, p.key, v)"
                @dblclick="store.setRealtimeParam(ui.fxTarget, fx.uid, p.key, p.default)"
              />
            </div>
            <q-select
              v-else-if="p.type === 'select'" :model-value="fx.params[p.key]" :options="p.options" :label="p.label"
              emit-value map-options dense dark outlined options-dense class="q-mb-xs"
              @update:model-value="v => store.setRealtimeParam(ui.fxTarget, fx.uid, p.key, v)"
            />
          </template>
        </div>
      </div>

      <q-btn-dropdown unelevated color="primary" icon="add" label="Adicionar efeito" class="full-width" dense no-caps>
        <q-list dense dark>
          <q-item v-for="d in REALTIME_EFFECTS" :key="d.id" v-close-popup clickable @click="add(d.id)">
            <q-item-section>
              <q-item-label>{{ d.name }}</q-item-label>
              <q-item-label caption class="mono">{{ d.source }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-btn-dropdown>
    </div>

    <template v-if="target && ui.fxTarget !== 'master'">
      <q-separator dark />
      <div class="q-pa-sm">
        <q-btn
          outline dense no-caps class="full-width" color="grey-4" icon="mdi-content-save-cog"
          label="Aplicar na faixa (renderizar)" :disable="!target.effects.length"
          title="Grava o resultado dos efeitos no áudio da faixa e esvazia a cadeia" @click="renderTrack"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
// Painel de efeitos em tempo real de uma faixa ou do master — o equivalente ao
// RealtimeEffectPanel do Audacity 3.2+ (src/effects/RealtimeEffectPanel.cpp).

import { computed, reactive } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { REALTIME_EFFECTS, realtimeDef } from 'src/audio/realtime'
import { guard } from 'src/composables/commands'

const store = useProjectStore()
const ui = useUiStore()
const closed = reactive({})

const target = computed(() => (ui.fxTarget === 'master' ? store.master : store.findTrack(ui.fxTarget)))
const targetOptions = computed(() => [
  { label: 'Master (todas as faixas)', value: 'master' },
  ...store.tracks.map(t => ({ label: t.name, value: t.id }))
])

const def = fx => realtimeDef(fx.type)
const toggleOpen = uid => { closed[uid] = !closed[uid] }
const fmt = (v, p) => `${Number(v).toFixed(p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0)}${p.unit ? ' ' + p.unit : ''}`

const add = type => guard(() => store.addRealtimeEffect(ui.fxTarget, type))
const renderTrack = () => guard(() => store.renderTrackEffects(ui.fxTarget), { loading: true })
</script>

<style scoped>
.fx-panel { background: var(--ed-panel); }
.empty { font-size: 12px; line-height: 1.5; padding: 8px 4px; }
.fx-card { background: var(--ed-panel-2); border: 1px solid var(--ed-border); border-radius: 6px; }
.fx-card.off { opacity: 0.55; }
.fx-head { padding: 4px 6px; }
.fx-name { font-weight: 500; font-size: 13px; cursor: pointer; }
.fx-body { padding: 2px 10px 8px; border-top: 1px solid var(--ed-border); }
.param { margin-top: 4px; }
</style>
