<template>
  <div class="history column no-wrap full-height">
    <div class="row items-center q-pa-sm">
      <q-icon name="history" class="q-mr-sm" />
      <div class="text-subtitle2">Histórico</div>
      <q-space />
      <q-btn flat dense round icon="close" size="sm" @click="ui.historyOpen = false" />
    </div>
    <q-separator dark />
    <q-list dense dark class="col scroll">
      <q-item
        v-for="(h, i) in store.history" :key="i" clickable :active="i === store.historyIndex"
        active-class="active" :class="{ future: i > store.historyIndex }" @click="store.goToState(i)"
      >
        <q-item-section>
          <q-item-label>{{ h.desc }}</q-item-label>
          <q-item-label caption>{{ h.time.toLocaleTimeString() }}</q-item-label>
        </q-item-section>
        <q-item-section v-if="i === store.savedIndex" side><q-icon name="save" size="14px" title="Estado salvo" /></q-item-section>
      </q-item>
    </q-list>
    <q-separator dark />
    <div class="q-pa-sm text-caption text-grey-6">
      {{ store.history.length }} estado(s). Clique para voltar a qualquer ponto — como a janela de Histórico do Audacity (src/HistoryWindow.cpp).
    </div>
  </div>
</template>

<script setup>
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'

const store = useProjectStore()
const ui = useUiStore()
</script>

<style scoped>
.history { background: var(--ed-panel); }
.active { background: rgba(139,92,246,0.25); color: white; }
.future { opacity: 0.45; }
</style>
