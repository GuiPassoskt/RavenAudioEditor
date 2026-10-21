<template>
  <!-- Plotar espectro (FreqWindow / PlotSpectrumBase) -->
  <q-dialog :model-value="ui.analysis === 'spectrum'" @update:model-value="v => !v && (ui.analysis = null)" @show="computeSpectrum">
    <q-card dark class="spectrum-card">
      <q-card-section class="row items-center q-pb-sm">
        <div class="text-h6">Análise de frequência</div>
        <q-space />
        <q-btn v-close-popup flat round dense icon="close" />
      </q-card-section>
      <q-card-section class="q-pt-none">
        <canvas ref="specCanvas" class="spec" @pointermove="onSpecMove" @pointerleave="hover = null" />
        <div class="row items-center q-gutter-md q-mt-sm">
          <q-select v-model="fftSize" :options="SIZES" label="Tamanho (FFT)" dense dark outlined style="width: 140px" @update:model-value="computeSpectrum" />
          <q-select v-model="axis" :options="AXES" emit-value map-options label="Eixo" dense dark outlined style="width: 160px" @update:model-value="drawSpectrum" />
          <q-space />
          <div class="mono text-caption">
            <template v-if="hover">Cursor: {{ hover.freq.toFixed(0) }} Hz · {{ hover.db.toFixed(1) }} dB</template>
            <template v-if="peak"><br>Pico: {{ peak.freq.toFixed(0) }} Hz ({{ peak.note }}) · {{ peak.db.toFixed(1) }} dB</template>
          </div>
        </div>
        <div class="text-caption text-grey-6 q-mt-xs">{{ info }}</div>
      </q-card-section>
    </q-card>
  </q-dialog>

  <!-- Encontrar clipping (FindClippingBase) -->
  <q-dialog :model-value="ui.analysis === 'clipping'" @update:model-value="v => !v && (ui.analysis = null)" @show="computeClipping">
    <q-card dark style="width: 440px">
      <q-card-section class="text-h6">Encontrar clipping</q-card-section>
      <q-card-section class="q-pt-none">
        <div class="row q-gutter-sm items-center q-mb-sm">
          <q-input v-model.number="minRun" type="number" label="Amostras seguidas para considerar clipping" dense dark outlined class="col" @update:model-value="computeClipping" />
        </div>
        <div v-if="!clips.length" class="text-positive">Nenhum clipping encontrado na seleção.</div>
        <q-list v-else dense dark bordered separator class="clip-list">
          <q-item v-for="(c, i) in clips" :key="i" v-close-popup clickable @click="selectClip(c)">
            <q-item-section>{{ c.track }} · canal {{ c.channel + 1 }}</q-item-section>
            <q-item-section side class="mono">{{ formatTime(c.t0) }} ({{ c.samples }} amostras)</q-item-section>
          </q-item>
        </q-list>
        <div v-if="clips.length" class="text-caption text-grey-6 q-mt-xs">{{ clips.length }} região(ões). Clique para selecionar.</div>
      </q-card-section>
      <q-card-actions align="right"><q-btn v-close-popup flat label="Fechar" /></q-card-actions>
    </q-card>
  </q-dialog>

  <!-- Estatísticas -->
  <q-dialog :model-value="ui.analysis === 'stats'" @update:model-value="v => !v && (ui.analysis = null)" @show="computeStats">
    <q-card dark style="width: 480px">
      <q-card-section class="text-h6">Estatísticas da seleção</q-card-section>
      <q-card-section class="q-pt-none">
        <q-markup-table dense dark flat bordered>
          <thead><tr><th class="text-left">Faixa / canal</th><th>Pico</th><th>RMS</th><th>DC</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in statRows" :key="i">
              <td>{{ r.name }}</td>
              <td class="mono text-right">{{ fmtDb(r.peakDb) }}</td>
              <td class="mono text-right">{{ fmtDb(r.rmsDb) }}</td>
              <td class="mono text-right">{{ (r.dc * 100).toFixed(3) }}%</td>
            </tr>
          </tbody>
        </q-markup-table>
      </q-card-section>
      <q-card-actions align="right"><q-btn v-close-popup flat label="Fechar" /></q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { nextTick, ref } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { averageSpectrum } from 'src/audio/dsp'
import { findClipping, stats } from 'src/audio/effects'
import { formatTime } from 'src/audio/time'

const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
const AXES = [{ label: 'Frequência log', value: 'log' }, { label: 'Frequência linear', value: 'linear' }]
const MAX_SECONDS = 240 // o Audacity limita a análise a ~237 s de áudio
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const store = useProjectStore()
const ui = useUiStore()

// ---------- Espectro ----------
const specCanvas = ref(null)
const fftSize = ref(2048)
const axis = ref('log')
const hover = ref(null)
const peak = ref(null)
const info = ref('')
let spectrum = null
let layout = null

function monoRegion (track) {
  const chans = store.regionChannels(track)
  const n = Math.min(chans[0].length, MAX_SECONDS * store.rate)
  const out = new Float32Array(n)
  for (const ch of chans) for (let i = 0; i < n; i++) out[i] += ch[i] / chans.length
  return out
}

function noteName (f) {
  const n = Math.round(12 * Math.log2(f / 440)) + 57
  return `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12)}`
}

async function computeSpectrum () {
  const track = store.selectedTracks.find(t => t.kind !== 'midi')
  if (!track) return
  const signal = monoRegion(track)
  if (signal.length < fftSize.value) {
    spectrum = null
    info.value = 'Selecione mais áudio: a seleção é menor que o tamanho da FFT.'
  } else {
    spectrum = averageSpectrum(signal, fftSize.value)
    info.value = `"${track.name}" · ${spectrum.windows} janelas de Hann com 50% de sobreposição`
    let best = 1
    for (let k = 1; k < spectrum.db.length; k++) if (spectrum.db[k] > spectrum.db[best]) best = k
    const freq = best * store.rate / fftSize.value
    peak.value = { freq, db: spectrum.db[best], note: noteName(freq) }
  }
  await nextTick()
  drawSpectrum()
}

function drawSpectrum () {
  const cv = specCanvas.value
  if (!cv) return
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  const h = cv.clientHeight
  cv.width = w * dpr
  cv.height = h * dpr
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = '#0b0812'
  g.fillRect(0, 0, w, h)
  const pad = { l: 42, r: 10, t: 10, b: 24 }
  const nyq = store.rate / 2
  const fMin = axis.value === 'log' ? 20 : 0
  const xOfF = f => axis.value === 'log'
    ? pad.l + Math.log(Math.max(f, fMin) / fMin) / Math.log(nyq / fMin) * (w - pad.l - pad.r)
    : pad.l + f / nyq * (w - pad.l - pad.r)
  const dbTop = 0
  const dbBottom = -108
  const yOfDb = db => pad.t + (dbTop - Math.max(dbBottom, Math.min(dbTop, db))) / (dbTop - dbBottom) * (h - pad.t - pad.b)
  layout = { pad, w, h, nyq, fMin, dbTop, dbBottom }

  g.font = '10px Roboto, sans-serif'
  g.fillStyle = '#9a8db5'
  g.strokeStyle = '#221933'
  for (let db = dbTop; db >= dbBottom; db -= 12) {
    const y = yOfDb(db)
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke()
    g.fillText(`${db} dB`, 2, y + 3)
  }
  const freqs = axis.value === 'log' ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] : [0, 2000, 5000, 10000, 15000, 20000]
  for (const f of freqs.filter(x => x <= nyq)) {
    const x = xOfF(f)
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, h - pad.b); g.stroke()
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x - 8, h - 8)
  }
  if (!spectrum) return

  const bins = spectrum.db
  g.beginPath()
  g.moveTo(xOfF(fMin), h - pad.b)
  for (let k = 1; k < bins.length; k++) {
    const f = k * store.rate / fftSize.value
    if (f < fMin) continue
    g.lineTo(xOfF(f), yOfDb(bins[k]))
  }
  g.lineTo(xOfF(nyq), h - pad.b)
  g.closePath()
  g.fillStyle = 'rgba(167,123,255,0.35)'
  g.fill()
  g.strokeStyle = '#a77bff'
  g.stroke()
}

function onSpecMove (e) {
  if (!spectrum || !layout) return
  const { pad, w, nyq, fMin } = layout
  const x = e.offsetX
  const frac = (x - pad.l) / (w - pad.l - pad.r)
  if (frac < 0 || frac > 1) { hover.value = null; return }
  const freq = axis.value === 'log' ? fMin * Math.pow(nyq / fMin, frac) : frac * nyq
  const k = Math.min(spectrum.db.length - 1, Math.max(1, Math.round(freq * fftSize.value / store.rate)))
  hover.value = { freq, db: spectrum.db[k] }
}

// ---------- Clipping ----------
const minRun = ref(3)
const clips = ref([])
function computeClipping () {
  const out = []
  for (const t of store.selectedTracks.filter(x => x.kind !== 'midi')) {
    const [s0] = store.regionOf(t)
    const base = t.offset + s0 / store.rate
    for (const hit of findClipping(store.regionChannels(t), store.rate, Math.max(1, minRun.value))) {
      out.push({ ...hit, track: t.name, t0: hit.t0 + base, t1: hit.t1 + base, id: t.id })
    }
  }
  clips.value = out.slice(0, 500)
}
function selectClip (c) {
  store.selectTrack(c.id)
  store.setSelection(c.t0, c.t1)
  store.ensureVisible(c.t0)
}

// ---------- Estatísticas ----------
const statRows = ref([])
function computeStats () {
  statRows.value = store.selectedTracks.filter(t => t.kind !== 'midi').flatMap(t =>
    stats(store.regionChannels(t)).map((s, c) => ({ ...s, name: `${t.name}${t.channels.length > 1 ? (c ? ' (D)' : ' (E)') : ''}` })))
}
const fmtDb = v => (isFinite(v) ? `${v.toFixed(2)} dB` : '-∞ dB')
</script>

<style scoped>
.spectrum-card { width: 760px; max-width: 96vw; }
.spec { width: 100%; height: 320px; display: block; border-radius: 4px; cursor: crosshair; }
.clip-list { max-height: 300px; overflow-y: auto; }
</style>
