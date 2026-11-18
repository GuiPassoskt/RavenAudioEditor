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
      <div v-if="frozen" class="frozen row items-center no-wrap">
        <q-icon name="mdi-snowflake" size="18px" class="q-mr-sm" />
        <div class="col">Faixa congelada: o que está aqui já foi renderizado no áudio. Mudar algo descongela a faixa.</div>
        <q-btn flat dense no-caps size="sm" label="Descongelar" @click="store.unfreezeTrack(target.id)" />
      </div>

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
          <div class="col q-ml-xs ellipsis fx-name" @click="toggleOpen(fx.uid)">
            <q-icon v-if="fx.type === 'plugin'" name="mdi-puzzle-outline" size="14px" class="q-mr-xs text-grey-5" />{{ effectName(fx) }}
          </div>
          <q-btn flat dense round size="xs" icon="arrow_upward" :disable="i === 0" title="Mover para cima" @click="store.moveRealtimeEffect(ui.fxTarget, fx.uid, -1)" />
          <q-btn flat dense round size="xs" icon="arrow_downward" :disable="i === target.effects.length - 1" title="Mover para baixo" @click="store.moveRealtimeEffect(ui.fxTarget, fx.uid, 1)" />
          <q-btn flat dense round size="xs" :icon="closed[fx.uid] ? 'expand_more' : 'expand_less'" @click="toggleOpen(fx.uid)" />
          <q-btn flat dense round size="xs" icon="delete" color="grey-5" title="Remover" @click="store.removeRealtimeEffect(ui.fxTarget, fx.uid)" />
        </div>
        <div v-if="!closed[fx.uid]" class="fx-body">
          <PluginSlotBody v-if="fx.type === 'plugin'" :fx="fx" />
          <template v-for="p in def(fx)?.params ?? []" :key="p.key">
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
          <template v-if="hasNativeEngine">
            <q-separator dark />
            <q-item v-close-popup clickable @click="pickerOpen = true">
              <q-item-section avatar style="min-width: 28px"><q-icon name="mdi-puzzle-outline" size="18px" /></q-item-section>
              <q-item-section>
                <q-item-label>Plugin (VST3 / LV2)…</q-item-label>
                <q-item-label caption>Plugins instalados no computador</q-item-label>
              </q-item-section>
            </q-item>
          </template>
        </q-list>
      </q-btn-dropdown>
      <PluginPickerDialog v-if="hasNativeEngine" v-model="pickerOpen" @pick="addPlugin" />

      <!-- Envios (pós-fader) para barramentos -->
      <template v-if="ui.fxTarget !== 'master'">
        <q-separator dark class="q-my-sm" />
        <div v-if="target.kind === 'bus'" class="sends">
          <div class="text-subtitle2">Recebe envios de</div>
          <div v-if="!senders.length" class="empty text-grey-6">
            Nenhuma faixa envia para este barramento ainda. Abra os efeitos de uma faixa e use "Adicionar envio".
          </div>
          <div v-for="s in senders" :key="s.track.id" class="row items-center no-wrap sender">
            <span class="col ellipsis">{{ s.track.name }}</span>
            <span class="mono text-grey-5">{{ fmtDb(s.level) }}</span>
          </div>
        </div>
        <div v-else class="sends">
          <div class="text-subtitle2">Envios</div>
          <div v-if="!target.sends.length" class="empty text-grey-6">
            Envios mandam uma cópia do som da faixa (depois do volume e do pan) para um barramento,
            onde vários sons dividem os mesmos efeitos, como um reverb.
          </div>
          <div v-for="s in target.sends" :key="s.bus" class="param">
            <div class="row items-center no-wrap text-caption">
              <q-icon name="mdi-call-merge" size="14px" class="q-mr-xs text-grey-5" />
              <span class="col ellipsis">{{ store.findTrack(s.bus)?.name }}</span>
              <span class="mono">{{ fmtDb(s.level) }}</span>
              <q-btn flat dense round size="xs" icon="close" color="grey-5" title="Remover envio" @click="store.removeSend(target.id, s.bus)" />
            </div>
            <q-slider
              :model-value="s.level" :min="-60" :max="6" :step="0.5" dense dark color="primary"
              @update:model-value="v => store.setSendLevel(target.id, s.bus, v)"
              @dblclick="store.setSendLevel(target.id, s.bus, 0)"
            />
          </div>
          <q-btn-dropdown outline color="grey-4" icon="mdi-call-merge" label="Adicionar envio" class="full-width" dense no-caps>
            <q-list dense dark>
              <q-item v-for="b in freeBuses" :key="b.id" v-close-popup clickable @click="addSend(b.id)">
                <q-item-section>{{ b.name }}</q-item-section>
              </q-item>
              <q-separator v-if="freeBuses.length" dark />
              <q-item v-close-popup clickable @click="addSendToNewBus">
                <q-item-section avatar style="min-width: 28px"><q-icon name="add" size="18px" /></q-item-section>
                <q-item-section>Novo barramento</q-item-section>
              </q-item>
            </q-list>
          </q-btn-dropdown>
        </div>
      </template>
    </div>

    <template v-if="target && ui.fxTarget !== 'master'">
      <q-separator dark />
      <div class="q-pa-sm">
        <q-btn
          outline dense no-caps class="full-width" color="grey-4" icon="mdi-content-save-cog"
          label="Aplicar na faixa (renderizar)" :disable="!target.effects.length || target.kind === 'bus' || frozen"
          title="Grava o resultado dos efeitos no áudio da faixa e esvazia a cadeia" @click="renderTrack"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
// Painel de efeitos em tempo real de uma faixa ou do master — o equivalente ao
// RealtimeEffectPanel do Audacity 3.2+ (src/effects/RealtimeEffectPanel.cpp).

import { computed, reactive, ref } from 'vue'
import { isFrozen, useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { REALTIME_EFFECTS, effectName, realtimeDef } from 'src/audio/realtime'
import { hasNativeEngine } from 'src/audio/plugins'
import { guard } from 'src/composables/commands'
import PluginPickerDialog from 'components/PluginPickerDialog.vue'
import PluginSlotBody from 'components/PluginSlotBody.vue'

const store = useProjectStore()
const ui = useUiStore()
const closed = reactive({})
const pickerOpen = ref(false)

const target = computed(() => (ui.fxTarget === 'master' ? store.master : store.findTrack(ui.fxTarget)))
const targetOptions = computed(() => [
  { label: 'Master (todas as faixas)', value: 'master' },
  ...store.tracks.map(t => ({ label: t.name, value: t.id }))
])

const frozen = computed(() => target.value && ui.fxTarget !== 'master' && isFrozen(target.value))
const freeBuses = computed(() => store.buses.filter(b => !target.value?.sends?.some(s => s.bus === b.id)))
const senders = computed(() => store.tracks.flatMap(t => (t.sends ?? [])
  .filter(s => s.bus === target.value?.id)
  .map(s => ({ track: t, level: s.level }))))
const fmtDb = v => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`

const def = fx => realtimeDef(fx.type)
const toggleOpen = uid => { closed[uid] = !closed[uid] }
const fmt = (v, p) => `${Number(v).toFixed(p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0)}${p.unit ? ' ' + p.unit : ''}`

const add = type => guard(() => store.addRealtimeEffect(ui.fxTarget, type))
const addPlugin = plugin => plugin && guard(() => store.addRealtimePlugin(ui.fxTarget, plugin))
const renderTrack = () => guard(() => store.renderTrackEffects(ui.fxTarget), { loading: true })
const addSend = busId => guard(() => store.addSend(ui.fxTarget, busId))
// O barramento novo entra logo abaixo, e o painel continua na faixa.
const addSendToNewBus = () => guard(() => {
  const trackId = ui.fxTarget
  const bus = store.newBusTrack()
  store.addSend(trackId, bus.id)
  store.selectTrack(trackId)
})
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
.frozen { background: rgba(160, 210, 255, 0.12); border: 1px solid rgba(160, 210, 255, 0.35); border-radius: 6px; padding: 6px 8px; font-size: 12px; color: #cfe8ff; }
.sends { display: flex; flex-direction: column; gap: 6px; }
.sender { font-size: 12px; }
</style>
