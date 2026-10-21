<template>
  <q-dialog
    :model-value="ui.splashOpen" transition-show="fade" transition-hide="fade"
    :persistent="!ready" @update:model-value="v => !v && close()"
  >
    <div class="splash">
      <!-- Arte -->
      <div class="art">
        <img src="assets/img/splash/splash.png" alt="Raven Audio Editor">
        <div class="art-fade" />
        <div class="version-chip mono">v{{ appVersion }}</div>
      </div>

      <!-- Informações técnicas -->
      <div class="info column no-wrap">
        <div class="head">
          <div class="title">Raven Audio Editor</div>
          <div class="subtitle">Editor de áudio multipista · MIDI · mesa de som</div>
        </div>

        <div class="sections col">
          <section>
            <h6>Aplicação</h6>
            <dl>
              <dt>Versão</dt><dd class="mono">{{ appVersion }}</dd>
              <dt>Build</dt><dd class="mono">{{ buildDate }}</dd>
              <dt>Execução</dt><dd>{{ runtime }}</dd>
              <dt>Framework</dt><dd class="mono">Quasar {{ $q.version }} · Vue {{ vueVersion }}</dd>
            </dl>
          </section>

          <section>
            <h6>Motor de áudio</h6>
            <dl>
              <dt>API</dt><dd>Web Audio API</dd>
              <dt>Taxa do dispositivo</dt><dd class="mono">{{ info.sampleRate ? info.sampleRate + ' Hz' : '…' }}</dd>
              <dt>Taxa do projeto</dt><dd class="mono">{{ store.rate }} Hz · 32-bit float</dd>
              <dt>Latência base</dt><dd class="mono">{{ ms(info.baseLatency) }}</dd>
              <dt>Canais de saída</dt><dd class="mono">{{ info.maxChannels ?? '…' }}</dd>
              <dt>AudioWorklet</dt><dd><Flag :on="info.worklet" yes="disponível" no="indisponível" /></dd>
            </dl>
          </section>

          <section>
            <h6>Sistema</h6>
            <dl>
              <dt>Plataforma</dt><dd>{{ info.platform || '…' }}</dd>
              <dt>Navegador</dt><dd>{{ info.browser || '…' }}</dd>
              <dt>Processador</dt><dd class="mono">{{ info.cores ? info.cores + ' núcleos' : '—' }}</dd>
              <dt>Memória</dt><dd class="mono">{{ info.memory ? '≥ ' + info.memory + ' GB' : 'não informada' }}</dd>
              <dt>Disp. de áudio</dt>
              <dd class="mono">{{ info.inputs ?? '…' }} entradas · {{ info.outputs ?? '…' }} saídas</dd>
              <dt>Web MIDI</dt><dd><Flag :on="info.midi" yes="disponível" no="indisponível" /></dd>
            </dl>
          </section>

          <section>
            <h6>Formatos de importação</h6>
            <div class="chips">
              <span v-for="f in info.formats" :key="f" class="chip">{{ f }}</span>
              <span class="chip midi">MIDI (.mid)</span>
              <span class="chip">Projeto .ravenproj</span>
            </div>
          </section>

          <section class="full">
            <h6>Recursos</h6>
            <div class="chips">
              <span v-for="f in FEATURES" :key="f" class="chip feat">{{ f }}</span>
            </div>
          </section>
        </div>

        <!-- Progresso da inicialização -->
        <div class="boot">
          <div class="bar"><div class="bar-fill" :style="{ width: progress * 100 + '%' }" /></div>
          <div class="row items-center no-wrap q-mt-sm">
            <span class="step mono">{{ stepText }}</span>
            <q-space />
            <span class="keys">
              <kbd>Espaço</kbd> tocar · <kbd>R</kbd> gravar · <kbd>F2</kbd> atalhos
            </span>
          </div>
          <div class="row items-center no-wrap q-mt-md">
            <q-checkbox v-model="hideOnStart" dense dark size="sm" color="primary" label="Não mostrar ao iniciar" class="hide-check" />
            <q-space />
            <button class="start" :disabled="!ready" @click="close">
              {{ ready ? 'Começar' : 'Inicializando…' }}
              <q-icon v-if="ready" name="sym_r_arrow_forward" size="18px" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </q-dialog>
</template>

<script setup>
// Tela de abertura com informações técnicas da aplicação e um diagnóstico
// real do ambiente (motor de áudio, dispositivos, formatos suportados).
import { h, reactive, ref, watch, version as vueVersion } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import pkg from '../../package.json'

const HIDE_KEY = 'raven.splash.hide' // a mesma chave é lida em EditorPage.vue
const FEATURES = ['Multipista', 'Gravação mono/estéreo', 'Efeitos em tempo real', 'Mesa de som', 'Piano roll',
  'Sintetizador GM', 'Análise de espectro', 'Desfazer/refazer', 'Exportar WAV e MIDI']
const FORMATS = [
  ['WAV', 'audio/wav'], ['MP3', 'audio/mpeg'], ['OGG Vorbis', 'audio/ogg; codecs=vorbis'],
  ['Opus', 'audio/ogg; codecs=opus'], ['FLAC', 'audio/flac'], ['AAC / M4A', 'audio/mp4; codecs="mp4a.40.2"'],
  ['WebM', 'audio/webm; codecs=opus']
]

// Indicador sim/não.
const Flag = (props) => h('span', { class: props.on ? 'flag on' : props.on === false ? 'flag off' : 'flag' },
  props.on === undefined ? '…' : (props.on ? '● ' + props.yes : '○ ' + props.no))
Flag.props = ['on', 'yes', 'no']

const store = useProjectStore()
const ui = useUiStore()

const appVersion = pkg.version
const buildDate = (() => {
  const d = new Date(process.env.BUILD_DATE || Date.now())
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
})()
const runtime = navigator.userAgent.includes('Electron')
  ? 'Desktop (Electron)'
  : `Navegador (SPA)${process.env.DEV ? ' · desenvolvimento' : ''}`

const info = reactive({ formats: [] })
const progress = ref(0)
const stepText = ref('')
const ready = ref(false)
let hide = false
try { hide = localStorage.getItem(HIDE_KEY) === '1' } catch { /* sem storage */ }
const hideOnStart = ref(hide)

const ms = s => (typeof s === 'number' ? `${(s * 1000).toFixed(1)} ms` : '…')
const pause = t => new Promise(r => setTimeout(r, t))

// Cada etapa é uma verificação real; a pausa curta só deixa o progresso legível.
const STEPS = [
  ['Iniciando motor de áudio', async () => {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    info.sampleRate = ctx.sampleRate
    info.baseLatency = ctx.baseLatency
    info.maxChannels = ctx.destination.maxChannelCount
    info.worklet = !!ctx.audioWorklet
    await ctx.close()
  }],
  ['Detectando dispositivos de áudio', async () => {
    const list = await navigator.mediaDevices?.enumerateDevices?.() ?? []
    info.inputs = list.filter(d => d.kind === 'audioinput').length
    info.outputs = list.filter(d => d.kind === 'audiooutput').length
  }],
  ['Verificando sistema e MIDI', async () => {
    const uad = navigator.userAgentData
    info.platform = uad?.platform || navigator.platform || 'desconhecida'
    const brand = uad?.brands?.find(b => !/not.?a.?brand|chromium/i.test(b.brand)) ?? uad?.brands?.[0]
    info.browser = brand ? `${brand.brand} ${brand.version}` : navigator.userAgent.split(' ').pop()
    info.cores = navigator.hardwareConcurrency
    info.memory = navigator.deviceMemory
    info.midi = 'requestMIDIAccess' in navigator // só detecta; não pede permissão
  }],
  ['Verificando formatos de áudio', async () => {
    const a = document.createElement('audio')
    info.formats = FORMATS.filter(([, mime]) => a.canPlayType(mime) !== '').map(([name]) => name)
  }],
  ['Carregando interface', async () => { await document.fonts?.ready }]
]

async function boot () {
  ready.value = false
  progress.value = 0
  for (let i = 0; i < STEPS.length; i++) {
    const [label, run] = STEPS[i]
    stepText.value = `${label}…`
    try { await run() } catch { /* item fica como indisponível */ }
    progress.value = (i + 1) / STEPS.length
    await pause(180)
  }
  stepText.value = 'Pronto'
  ready.value = true
}

function close () {
  if (!ready.value) return
  try { localStorage.setItem(HIDE_KEY, hideOnStart.value ? '1' : '0') } catch { /* sem storage */ }
  ui.splashOpen = false
}

watch(() => ui.splashOpen, open => { if (open) boot() }, { immediate: true })
</script>

<style scoped>
.splash {
  width: 1040px;
  max-width: 96vw;
  height: 690px;
  max-height: 92vh;
  display: flex;
  background: #0b0812;
  border-radius: 18px;
  overflow: hidden;
  border: 1px solid #2f2345;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6), 0 0 60px rgba(139, 92, 246, 0.18);
}

/* Arte à esquerda */
.art { position: relative; width: 42%; flex: none; background: #010104; /* mesma cor do fundo da arte */ display: flex; align-items: center; }
/* contain: a arte quadrada aparece inteira; o fundo preto completa o espaço */
.art img { width: 100%; height: 100%; object-fit: contain; display: block; }
.art-fade { position: absolute; inset: 0; background: linear-gradient(90deg, transparent 78%, #0b0812 100%); pointer-events: none; }
.version-chip {
  position: absolute; left: 16px; bottom: 16px; font-size: 11px; color: #efe9fb;
  padding: 3px 10px; border-radius: 999px; background: rgba(139, 92, 246, 0.25); border: 1px solid rgba(201, 179, 255, 0.35);
}

/* Painel técnico à direita */
.info { flex: 1; min-width: 0; padding: 26px 28px 22px; color: #efe9fb; }
.title {
  font-size: 26px; font-weight: 700; letter-spacing: 0.5px;
  background: linear-gradient(90deg, #e9ddff, #c9b3ff 40%, #8b5cf6);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.subtitle { font-size: 12.5px; color: #a99cc4; margin-top: 2px; letter-spacing: 0.3px; }

.sections {
  margin-top: 14px; overflow-y: auto; min-height: 0;
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px 22px; align-content: start;
}
section { min-width: 0; }
h6 {
  margin: 0 0 6px; font-size: 10.5px; font-weight: 600; letter-spacing: 1.6px; text-transform: uppercase;
  color: #ff7a1a;
}
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; }
dt { color: #9a8db5; white-space: nowrap; }
dd { margin: 0; color: #efe9fb; overflow-wrap: anywhere; }
section.full { grid-column: 1 / -1; }
.flag { color: #9a8db5; }
.flag.on { color: #c9b3ff; }
.flag.off { color: #e5484d; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 11px; padding: 2px 9px; border-radius: 999px;
  background: #1d1530; border: 1px solid #33264d; color: #d4c8ec;
}
.chip.midi { border-color: rgba(224, 53, 155, 0.6); color: #ff9fd2; }
.chip.feat { background: rgba(139, 92, 246, 0.12); border-color: rgba(139, 92, 246, 0.4); }

/* Inicialização */
.boot { margin-top: 16px; }
.bar { height: 4px; border-radius: 999px; background: #1d1530; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, #8b5cf6, #e0359b 55%, #ff7a1a); transition: width 0.25s ease; box-shadow: 0 0 10px rgba(224, 53, 155, 0.6); }
.step { font-size: 11.5px; color: #a99cc4; }
.keys { font-size: 11px; color: #9a8db5; }
kbd { font-family: inherit; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: #1d1530; border: 1px solid #33264d; color: #d4c8ec; }
.hide-check { font-size: 12px; color: #a99cc4; }
.start {
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 22px; border: none; border-radius: 999px; cursor: pointer;
  font-size: 14px; font-weight: 600; color: #fff;
  background: linear-gradient(90deg, #8b5cf6, #e0359b 60%, #ff7a1a);
  box-shadow: 0 6px 20px rgba(224, 53, 155, 0.35);
  transition: transform 0.12s, filter 0.12s, opacity 0.2s;
}
.start:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
.start:disabled { opacity: 0.5; cursor: default; }

@media (max-width: 820px) {
  /* Em tela estreita o modal inteiro rola, para o botão "Começar" nunca sumir. */
  .splash { flex-direction: column; height: auto; max-height: 94vh; overflow-y: auto; }
  .sections { overflow: visible; }
  .art { width: 100%; height: 220px; }
  .art img { object-position: center 30%; }
  .art-fade { background: linear-gradient(180deg, transparent 60%, #0b0812 100%); }
  .sections { grid-template-columns: 1fr; }
}
</style>
