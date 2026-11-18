<template>
  <q-layout view="hHh lpR fFf" class="editor-layout">
    <q-header class="editor-header">
      <MenuBar />
      <MainToolbar />
    </q-header>

    <q-drawer
      :model-value="ui.fxTarget !== null" side="left" :width="300" bordered dark
      @update:model-value="v => { if (!v) ui.fxTarget = null }"
    >
      <RealtimeEffectsPanel v-if="ui.fxTarget !== null" />
    </q-drawer>

    <q-drawer v-model="ui.historyOpen" side="right" :width="280" bordered dark overlay>
      <HistoryPanel />
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>

    <q-footer>
      <SelectionBar />
    </q-footer>

    <EffectDialog />
    <PluginEffectDialog v-if="hasNativeEngine" />
    <AudioDevicesDialog v-if="hasNativeEngine" />
    <PluginPickerDialog
      v-if="hasNativeEngine" instruments :model-value="ui.instrumentPicker !== null"
      @update:model-value="v => { if (!v) ui.instrumentPicker = null }"
      @pick="plugin => plugin && store.setTrackInstrumentPlugin(ui.instrumentPicker, plugin)"
    />
    <AnalysisDialogs />
    <InfoDialogs />
    <SplashDialog />
  </q-layout>
</template>

<script setup>
import { computed, onBeforeUnmount, watch } from 'vue'
import { Notify } from 'quasar'
import { useUiStore } from 'src/stores/ui'
import { useProjectStore } from 'src/stores/project'
import { hasNativeEngine, nativePlugins } from 'src/audio/plugins'
import { engine } from 'src/audio/engine'
import { effectName } from 'src/audio/realtime'
import MenuBar from 'components/MenuBar.vue'
import MainToolbar from 'components/MainToolbar.vue'
import SelectionBar from 'components/SelectionBar.vue'
import HistoryPanel from 'components/HistoryPanel.vue'
import EffectDialog from 'components/EffectDialog.vue'
import PluginEffectDialog from 'components/PluginEffectDialog.vue'
import AudioDevicesDialog from 'components/AudioDevicesDialog.vue'
import PluginPickerDialog from 'components/PluginPickerDialog.vue'
import AnalysisDialogs from 'components/AnalysisDialogs.vue'
import InfoDialogs from 'components/InfoDialogs.vue'
import RealtimeEffectsPanel from 'components/RealtimeEffectsPanel.vue'
import SplashDialog from 'components/SplashDialog.vue'

const ui = useUiStore()
const store = useProjectStore()

// Plugins nas cadeias em tempo real (Fase 3): o motor avisa quando o usuário mexe
// no plugin (o ajuste entra no histórico) e quando um plugin não carrega.
const offEngineEvents = nativePlugins.onEvent((name, msg) => {
  if (name === 'chain.pluginState') {
    const version = store.setPluginStateByUid(msg.uid, msg.state)
    if (version !== null) engine.markPluginStateSent?.(msg.uid, version)
  } else if (name === 'chain.pluginError') {
    const fx = [store.master, ...store.tracks].flatMap(t => t.effects ?? []).find(e => String(e.uid) === String(msg.uid))
    Notify.create({ type: 'warning', message: `${fx ? effectName(fx) : 'Plugin'}: ${msg.message} O som passa sem este efeito.`, position: 'bottom', timeout: 5000 })
  }
})
onBeforeUnmount(offEngineEvents)

// A entrada MIDI toca na faixa MIDI selecionada: o motor precisa saber qual é.
const selectedMidiTrack = computed(() => store.tracks.find(t => t.kind === 'midi' && t.selected)?.id ?? null)
watch(selectedMidiTrack, () => store.syncEngine())
</script>

<style scoped>
.editor-header { background: var(--ed-panel); color: #efe9fb; }
</style>
