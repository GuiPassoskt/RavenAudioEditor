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
    <AnalysisDialogs />
    <InfoDialogs />
    <SplashDialog />
  </q-layout>
</template>

<script setup>
import { useUiStore } from 'src/stores/ui'
import MenuBar from 'components/MenuBar.vue'
import MainToolbar from 'components/MainToolbar.vue'
import SelectionBar from 'components/SelectionBar.vue'
import HistoryPanel from 'components/HistoryPanel.vue'
import EffectDialog from 'components/EffectDialog.vue'
import AnalysisDialogs from 'components/AnalysisDialogs.vue'
import InfoDialogs from 'components/InfoDialogs.vue'
import RealtimeEffectsPanel from 'components/RealtimeEffectsPanel.vue'
import SplashDialog from 'components/SplashDialog.vue'

const ui = useUiStore()
</script>

<style scoped>
.editor-header { background: var(--ed-panel); color: #efe9fb; }
</style>
