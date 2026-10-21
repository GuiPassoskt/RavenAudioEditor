<template>
  <div class="main-toolbar row items-center">
    <!-- Desfazer / refazer -->
    <div class="pill">
      <button class="pbtn" :disabled="!store.canUndo" title="Desfazer (Ctrl+Z)" @click="exec('undo')">
        <q-icon name="sym_r_undo" size="22px" />
      </button>
      <button class="pbtn" :disabled="!store.canRedo" title="Refazer (Ctrl+Y)" @click="exec('redo')">
        <q-icon name="sym_r_redo" size="22px" />
      </button>
    </div>

    <!-- Transporte (ControlToolBar do Audacity) -->
    <div class="pill transport">
      <button
        class="pbtn" :class="{ active: store.paused }" :disabled="!store.playing && !store.paused"
        :title="store.paused ? 'Continuar (P)' : 'Pausar (P)'" @click="exec('pause')"
      >
        <q-icon :name="store.paused ? 'sym_r_resume' : 'sym_r_pause'" size="26px" class="filled" />
      </button>
      <button class="pbtn" title="Ir para o início (Home)" @click="exec('skipStart')">
        <q-icon name="sym_r_skip_previous" size="26px" class="filled" />
      </button>
      <button
        class="pbtn play" :class="{ on: store.playing }" :disabled="store.recording"
        title="Reproduzir (Espaço)" @click="store.playing ? null : exec('playStop')"
      >
        <q-icon name="sym_r_play_arrow" size="30px" class="filled" />
      </button>
      <button class="pbtn" :disabled="!store.playing && !store.paused && !store.recording" title="Parar" @click="exec('stop')">
        <q-icon name="sym_r_stop" size="26px" class="filled" />
      </button>
      <button class="pbtn rec" :class="{ on: store.recording }" title="Gravar na faixa selecionada (R)" @click="exec('record')">
        <span class="rec-dot" />
      </button>
      <button class="pbtn" :class="{ active: store.loop }" title="Loop da seleção (L)" @click="exec('loop')">
        <q-icon name="sym_r_repeat" size="24px" />
      </button>
      <button class="pbtn" title="Ir para o fim (End)" @click="exec('skipEnd')">
        <q-icon name="sym_r_skip_next" size="26px" class="filled" />
      </button>
    </div>

    <!-- Tempo e andamento -->
    <div class="pill display" title="Posição de áudio">
      <span class="time mono" :class="{ live: store.playing || store.recording }">{{ timeText }}</span>
    </div>
    <div class="pill display">
      <span class="bpm" title="Andamento (clique para editar)">
        <b class="mono">{{ store.tempo }}</b><small>bpm</small>
        <q-popup-edit v-slot="scope" :model-value="store.tempo" auto-save dark @save="v => store.setTempo(v)">
          <q-input v-model.number="scope.value" type="number" dense autofocus dark suffix="bpm" @keyup.enter="scope.set" />
        </q-popup-edit>
      </span>
      <span class="sep" />
      <span class="meter-sig mono">4<i>/</i>4</span>
    </div>

    <!-- Ferramentas (ToolsToolBar) -->
    <div class="pill">
      <button class="pbtn compact" :class="{ active: store.tool === 'select' }" title="Seleção (F1)" @click="exec('toolSelect')">
        <q-icon name="sym_r_text_select_start" size="20px" />
      </button>
      <button class="pbtn compact" :class="{ active: store.tool === 'shift' }" title="Mover no tempo (F5)" @click="exec('toolShift')">
        <q-icon name="sym_r_swap_horiz" size="20px" />
      </button>
    </div>

    <!-- Edição -->
    <div class="pill">
      <button
        v-for="id in editButtons" :key="id" class="pbtn compact"
        :disabled="cmds[id].enabled ? !cmds[id].enabled() : false"
        :title="`${cmds[id].label}${cmds[id].keys ? ' (' + cmds[id].keys + ')' : ''}`" @click="exec(id)"
      >
        <q-icon :name="iconOf(id)" size="20px" />
      </button>
    </div>

    <!-- Zoom e painéis -->
    <div class="pill">
      <button
        v-for="id in viewButtons" :key="id" class="pbtn compact" :class="{ active: isOpen(id) }"
        :title="`${cmds[id].label}${cmds[id].keys ? ' (' + cmds[id].keys + ')' : ''}`" @click="exec(id)"
      >
        <q-icon :name="iconOf(id)" size="20px" />
      </button>
    </div>

    <!-- Medidores (MeterToolBar) -->
    <div class="meters row no-wrap q-gutter-x-md q-px-sm">
      <LevelMeter :levels="[store.levels.rec, store.levels.rec]" icon="sym_r_mic" icon-color="red-4" title="Nível de gravação" />
      <LevelMeter :levels="store.levels.play" icon="sym_r_volume_up" icon-color="positive" title="Nível de reprodução" />
    </div>

    <q-space />
    <div class="status q-px-md" :class="statusClass">
      <span class="status-dot" />{{ statusText }}
    </div>
  </div>
</template>

<script setup>
// Barra principal: transporte, tempo, ferramentas, edição e medidores.
// Visual em "pílulas" arredondadas com ícones Material Symbols Rounded.
import { computed } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { useCommands } from 'src/composables/commands'
import { formatTime } from 'src/audio/time'
import LevelMeter from './LevelMeter.vue'

const store = useProjectStore()
const ui = useUiStore()
const { cmds, exec } = useCommands()

const editButtons = ['cut', 'copy', 'paste', 'trim', 'silence']
const viewButtons = ['zoomIn', 'zoomOut', 'zoomSel', 'zoomFit', 'mixer', 'pianoRoll', 'masterEffects']

// Ícones dos comandos usam nomes do Material Icons; aqui viram a versão arredondada.
const SWAP = { mixer: 'sym_r_tune', masterEffects: 'sym_r_instant_mix', pianoRoll: 'sym_r_piano' }
const iconOf = id => {
  const icon = SWAP[id] ?? cmds[id].icon
  return icon.startsWith('mdi-') || icon.startsWith('sym_') ? icon : `sym_r_${icon}`
}

const isOpen = id => (id === 'mixer' && ui.mixerOpen) || (id === 'pianoRoll' && ui.pianoRoll !== null) ||
  (id === 'masterEffects' && ui.fxTarget === 'master')

const timeText = computed(() => formatTime(store.playhead ?? store.sel.t0))

const statusText = computed(() => {
  if (store.recording) return 'Gravando'
  if (store.playing) return store.loop && store.playRange.isSelection ? 'Reproduzindo (loop)' : 'Reproduzindo'
  if (store.paused) return 'Pausado'
  return 'Parado'
})
const statusClass = computed(() => ({
  rec: store.recording,
  play: store.playing,
  paused: store.paused
}))
</script>

<style scoped>
.main-toolbar {
  background: var(--ed-panel-2);
  border-bottom: 1px solid var(--ed-border);
  min-height: 58px;
  padding: 7px 10px;
  gap: 8px;
  flex-wrap: wrap; /* sem espaço, quebra em mais uma linha em vez de esconder controles */
}

/* Pílula: grupo de botões com cantos totalmente arredondados */
.pill {
  display: flex;
  align-items: center;
  height: 42px;
  background: #140f1f;
  border: 1px solid #2f2345;
  border-radius: 999px;
  overflow: hidden;
  flex: none;
}
.pbtn {
  height: 100%;
  min-width: 46px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: #efe9fb;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.pbtn + .pbtn { border-left: 1px solid #2a1f3d; }
.pbtn:hover:not(:disabled) { background: #221933; }
.pbtn:active:not(:disabled) { background: #33264d; }
.pbtn:disabled { color: #6b5e85; cursor: default; }
.pbtn.compact { min-width: 34px; padding: 0 7px; }
.pbtn.active { color: #b79cff; background: rgba(139,92,246, 0.16); }

/* Ícones Material Symbols preenchidos (play, stop, pular) */
.filled { font-variation-settings: 'FILL' 1, 'wght' 500; }

.transport .pbtn { min-width: 52px; }
.pbtn.play { min-width: 60px; color: #fff; }
.pbtn.play.on { color: #3ddc84; }

/* Gravar: círculo vermelho cheio */
.rec-dot {
  width: 20px; height: 20px; border-radius: 50%;
  background: #e5484d;
  box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.6);
  transition: transform 0.12s;
}
.pbtn.rec:hover .rec-dot { transform: scale(1.08); }
.pbtn.rec.on .rec-dot { animation: pulse 1.1s ease-out infinite; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.7); }
  100% { box-shadow: 0 0 0 10px rgba(229, 72, 77, 0); }
}

/* Displays de tempo e andamento */
.display { padding: 0 18px; gap: 12px; }
.time { font-size: 22px; font-weight: 500; letter-spacing: 0.5px; color: #efe9fb; }
.time.live { color: #c9b3ff; }
.bpm { cursor: pointer; display: flex; align-items: baseline; gap: 4px; }
.bpm b { font-size: 22px; font-weight: 500; }
.bpm small { color: var(--ed-text-dim); font-size: 12px; }
.meter-sig { font-size: 20px; }
.meter-sig i { color: var(--ed-text-dim); font-style: normal; margin: 0 2px; }
.sep { width: 1px; height: 24px; background: #2f2345; }

.meters { flex: none; }
.meters :deep(.meter) { width: 150px; }
/* Em telas estreitas, a barra rola na horizontal em vez de esconder controles. */
@media (max-width: 1500px) {
  .display { padding: 0 12px; }
  .time, .bpm b { font-size: 18px; }
  .meter-sig { font-size: 17px; }
  .transport .pbtn { min-width: 44px; }
  .pbtn.play { min-width: 50px; }
  .meters :deep(.meter) { width: 120px; }
}

.status { font-size: 12px; white-space: nowrap; color: var(--ed-text-dim); display: flex; align-items: center; gap: 6px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b5e85; }
.status.play { color: #3ddc84; } .status.play .status-dot { background: #3ddc84; }
.status.rec { color: #ff6b6f; } .status.rec .status-dot { background: #e5484d; animation: pulse 1.1s ease-out infinite; }
.status.paused { color: #f2c037; } .status.paused .status-dot { background: #f2c037; }
</style>
