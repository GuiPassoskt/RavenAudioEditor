<template>
  <canvas
    ref="canvas"
    class="wave-canvas"
    :class="`tool-${store.tool}`"
    :style="{ height: height + 'px' }"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
  />
</template>

<script setup>
// Desenha o waveform de uma faixa. Mesma ideia do WaveformView do Audacity
// (src/tracks/playabletrack/wavetrack/ui/WaveformView.cpp): para cada coluna de
// pixel desenha min/max (cor forte) e RMS (cor clara); com zoom alto passa a
// ligar as amostras individuais e, mais perto ainda, a mostrar pontos.

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { rangeStats } from 'src/audio/summary'
import { trackDuration } from 'src/audio/engine'
import { useUiStore } from 'src/stores/ui'
import { rgba, shade, textOn } from 'src/audio/colors'

const CLIP_HEADER = 15 // faixa de título do clip, como nas DAWs

const props = defineProps({
  track: { type: Object, required: true },
  height: { type: Number, default: 140 }
})

const store = useProjectStore()
const ui = useUiStore()
const canvas = ref(null)
let frame = 0
let observer = null
let colors = null

function readColors () {
  const css = getComputedStyle(document.documentElement)
  const v = name => css.getPropertyValue(name).trim()
  colors = {
    bg: '#0e0a16', clip: v('--ed-track-bg'), clipSel: v('--ed-track-sel'),
    wave: v('--ed-wave'), rms: v('--ed-rms'), clipping: v('--ed-clip'),
    sel: v('--ed-selection'), axis: '#43345f', cursor: '#efe9fb'
  }
}

function scheduleDraw () {
  if (!frame) frame = requestAnimationFrame(draw)
}

function draw () {
  frame = 0
  const cv = canvas.value
  if (!cv) return
  if (!colors) readColors()
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  const h = props.height
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
  }
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)

  const { rate, pps, scrollTime, sel } = store
  const track = props.track
  const xOf = t => (t - scrollTime) * pps

  // Fundo fora do áudio e "clip" (região com áudio), pintado na cor da faixa.
  const color = track.color || '#3d7bf5'
  g.fillStyle = colors.bg
  g.fillRect(0, 0, w, h)
  const isMidi = track.kind === 'midi'
  const len = isMidi ? 0 : track.channels[0].length
  const rawX0 = xOf(track.offset)
  const rawX1 = xOf(track.offset + trackDuration(track, rate))
  const clipX0 = Math.max(0, rawX0)
  const clipX1 = Math.min(w, rawX1)
  const hasClip = clipX1 > clipX0 && (isMidi ? track.notes.length > 0 : len > 0)
  if (hasClip) {
    const x = Math.max(-4, rawX0) + 1
    const cw = Math.min(w + 4, rawX1) - x - 1
    g.save()
    g.beginPath()
    g.roundRect(x, 2, cw, h - 4, 4)
    g.fillStyle = rgba(color, track.selected ? 0.34 : 0.22)
    g.fill()
    g.strokeStyle = rgba(color, track.selected ? 1 : 0.75)
    g.lineWidth = 1
    g.stroke()
    g.clip()
    // Faixa de título com o nome da faixa.
    g.fillStyle = rgba(color, track.selected ? 1 : 0.88)
    g.fillRect(x, 2, cw, CLIP_HEADER)
    g.fillStyle = textOn(color)
    g.font = '600 11px Roboto, sans-serif'
    g.textBaseline = 'middle'
    g.fillText(track.name, Math.max(x, 0) + 6, 2 + CLIP_HEADER / 2 + 0.5)
    g.textBaseline = 'alphabetic'
    g.restore()
  }
  // Área útil do conteúdo (abaixo da faixa de título).
  const top0 = hasClip ? CLIP_HEADER + 4 : 0
  const contentH = h - top0 - 3
  const waveColor = shade(color, 0.35)
  const rmsColor = shade(color, 0.72)
  const axisColor = rgba(color, 0.35)

  // Seleção de tempo (só nas faixas selecionadas, como no Audacity).
  if (track.selected && sel.t1 > sel.t0) {
    const a = Math.max(0, xOf(sel.t0))
    const b = Math.min(w, xOf(sel.t1))
    if (b > a) {
      g.fillStyle = colors.sel
      g.fillRect(a, 0, b - a, h)
    }
  }

  if (isMidi) drawNotes(g, w, top0, contentH, xOf, color, clipX0, clipX1)

  const nCh = track.channels.length
  const laneH = contentH / nCh
  const spp = rate / pps // amostras por pixel

  track.channels.forEach((ch, c) => {
    const top = top0 + c * laneH
    const mid = top + laneH / 2
    const half = laneH / 2 - 2

    // Linhas de guia só dentro do clip.
    g.fillStyle = axisColor
    if (hasClip) {
      g.fillRect(clipX0, Math.round(mid), clipX1 - clipX0, 1)
      if (c > 0) g.fillRect(clipX0, Math.round(top), clipX1 - clipX0, 1)
    }
    if (!len) return

    const firstX = Math.max(0, Math.floor(clipX0))
    const lastX = Math.min(w, Math.ceil(clipX1))

    if (spp > 1) {
      for (let x = firstX; x < lastX; x++) {
        const a = (scrollTime + x / pps - track.offset) * rate
        const st = rangeStats(ch, a, a + spp)
        if (!st) continue
        const yMax = mid - Math.min(1, st.max) * half
        const yMin = mid - Math.max(-1, st.min) * half
        g.fillStyle = waveColor
        g.fillRect(x, yMax, 1, Math.max(1, yMin - yMax))
        const r = Math.min(st.rms, Math.max(st.max, 0), Math.max(-st.min, 0))
        if (r > 0) {
          g.fillStyle = rmsColor
          g.fillRect(x, mid - r * half, 1, Math.max(1, 2 * r * half))
        }
        if (st.max >= 1 || st.min <= -1) {
          g.fillStyle = colors.clipping
          g.fillRect(x, top, 1, laneH)
        }
      }
    } else {
      // Zoom no nível de amostra: polilinha (e pontos quando há espaço).
      const s0 = Math.max(0, Math.floor((scrollTime - track.offset) * rate) - 1)
      const s1 = Math.min(len, Math.ceil((scrollTime + w / pps - track.offset) * rate) + 1)
      g.strokeStyle = rmsColor
      g.lineWidth = 1.25
      g.beginPath()
      for (let i = s0; i < s1; i++) {
        const x = xOf(track.offset + i / rate)
        const y = mid - Math.max(-1, Math.min(1, ch[i])) * half
        if (i === s0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
      if (pps / rate > 6) {
        g.fillStyle = shade(color, 0.85)
        for (let i = s0; i < s1; i++) {
          const x = xOf(track.offset + i / rate)
          const y = mid - Math.max(-1, Math.min(1, ch[i])) * half
          g.fillRect(x - 2, y - 2, 4, 4)
        }
      }
    }
  })

  // Gravação em curso nesta faixa: trecho desenhado ao vivo, em vermelho.
  if (store.recTake?.ids.includes(track.id)) drawRecording(g, w, h, xOf)

  // Cursor de edição (seleção vazia).
  if (sel.t1 === sel.t0) {
    const x = Math.round(xOf(sel.t0)) + 0.5
    if (x >= 0 && x <= w) {
      g.strokeStyle = track.selected ? colors.cursor : 'rgba(239,233,251,0.35)'
      g.setLineDash([3, 3])
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke()
      g.setLineDash([])
    }
  }
}

function drawRecording (g, w, h, xOf) {
  const take = store.recTake
  const x0 = xOf(take.t0)
  const x1 = xOf(take.t0 + take.length / store.rate)
  if (x1 <= 0 || x0 >= w || x1 - x0 < 1) return
  const red = '#e5484d'
  g.save()
  g.beginPath()
  g.roundRect(x0 + 1, 2, Math.max(1, x1 - x0 - 1), h - 4, 4)
  g.fillStyle = '#2a1418'
  g.fill()
  g.fillStyle = rgba(red, 0.18)
  g.fill()
  g.strokeStyle = red
  g.stroke()
  g.clip()
  g.fillStyle = red
  g.fillRect(x0, 2, x1 - x0, CLIP_HEADER)
  g.fillStyle = '#fff'
  g.font = '600 11px Roboto, sans-serif'
  g.textBaseline = 'middle'
  g.fillText('● Gravando', Math.max(x0, 0) + 6, 2 + CLIP_HEADER / 2 + 0.5)
  g.textBaseline = 'alphabetic'

  const chans = store.recordingPreview(props.track)
  if (chans) {
    const top0 = CLIP_HEADER + 4
    const laneH = (h - top0 - 3) / chans.length
    const spp = store.rate / store.pps
    const a = Math.max(0, Math.floor(x0))
    const b = Math.min(w, Math.ceil(x1))
    g.fillStyle = shade(red, 0.4)
    chans.forEach((ch, c) => {
      const mid = top0 + c * laneH + laneH / 2
      const half = laneH / 2 - 2
      for (let x = a; x < b; x++) {
        const s = (store.scrollTime + x / store.pps - take.t0) * store.rate
        const st = rangeStats(ch, s, s + Math.max(1, spp))
        if (!st) continue
        const yMax = mid - Math.min(1, st.max) * half
        const yMin = mid - Math.max(-1, st.min) * half
        g.fillRect(x, yMax, 1, Math.max(1, yMin - yMax))
      }
    })
  }
  g.restore()
}

// Notas como retângulos, faixa de alturas ajustada ao conteúdo (NoteTrackView
// do Audacity usa a mesma ideia: bottom/top note e altura por semitom).
function drawNotes (g, w, top, h, xOf, color, clipX0, clipX1) {
  const { notes, offset } = props.track
  if (!notes.length) {
    g.fillStyle = rgba(color, 0.8)
    g.font = '11px Roboto, sans-serif'
    g.fillText('Faixa MIDI vazia — duplo clique para abrir o piano roll', 10, top + h / 2)
    return
  }
  let lo = 127; let hi = 0
  for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch) }
  if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 6); hi = Math.ceil(mid + 6) }
  const rows = hi - lo + 1
  const rowH = (h - 4) / rows
  g.fillStyle = rgba(color, 0.12)
  for (let p = lo; p <= hi; p++) if (p % 12 === 0) g.fillRect(clipX0, top + 2 + (hi - p) * rowH, clipX1 - clipX0, Math.max(1, rowH))
  const t0 = store.scrollTime - offset
  const t1 = t0 + w / store.pps
  for (const n of notes) {
    if (n.start > t1 || n.start + n.dur < t0) continue
    const x = xOf(offset + n.start)
    const nw = Math.max(1.5, n.dur * store.pps - 1)
    const y = top + 2 + (hi - n.pitch) * rowH
    g.fillStyle = shade(color, 0.35 + (n.vel / 127) * 0.45) // mais claro = mais forte
    g.fillRect(x, y, nw, Math.max(1.5, rowH - 1))
  }
}

// ---------- Interação ----------
const timeAt = clientX => {
  const rect = canvas.value.getBoundingClientRect()
  return Math.max(0, store.scrollTime + (clientX - rect.left) / store.pps)
}

function trackIdAtPoint (x, y) {
  const el = document.elementFromPoint(x, y)?.closest('[data-track-id]')
  return el ? Number(el.dataset.trackId) : null
}

function onPointerDown (e) {
  if (e.button !== 0) return
  const track = props.track
  const t = timeAt(e.clientX)
  let onMove

  if (store.tool === 'shift') {
    const startX = e.clientX
    const startOffset = track.offset
    store.selectTrack(track.id, e.ctrlKey || e.metaKey)
    onMove = ev => {
      track.offset = Math.max(0, startOffset + (ev.clientX - startX) / store.pps)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (track.offset !== startOffset) store.setTrackProp(track.id, 'offset', track.offset)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return
  }

  // Ferramenta de seleção: arrastar define o intervalo; shift estende.
  let anchor = t
  if (e.shiftKey) {
    const { t0, t1 } = store.sel
    anchor = Math.abs(t - t0) > Math.abs(t - t1) ? t0 : t1
  } else {
    store.selectTrack(track.id, e.ctrlKey || e.metaKey)
  }
  store.setSelection(anchor, t)
  const startIndex = store.tracks.findIndex(x => x.id === track.id)

  onMove = ev => {
    store.setSelection(anchor, timeAt(ev.clientX))
    const id = trackIdAtPoint(ev.clientX, ev.clientY)
    if (id !== null && !(e.ctrlKey || e.metaKey)) {
      const i = store.tracks.findIndex(x => x.id === id)
      const [lo, hi] = [Math.min(i, startIndex), Math.max(i, startIndex)]
      store.tracks.forEach((x, k) => { x.selected = k >= lo && k <= hi })
    }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onDoubleClick () {
  const t = props.track
  if (t.kind === 'midi') { store.selectTrack(t.id); ui.pianoRoll = t.id; return }
  store.selectTrack(t.id)
  store.setSelection(t.offset, store.trackEnd(t))
}

watch(
  () => [props.track.version, props.track.offset, props.track.selected, props.track.channels, props.track.notes, props.track.color, props.track.name, store.recTake,
    store.pps, store.scrollTime, store.sel.t0, store.sel.t1, store.rate, props.height],
  scheduleDraw
)

onMounted(() => {
  observer = new ResizeObserver(scheduleDraw)
  observer.observe(canvas.value)
  scheduleDraw()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})
</script>

<style scoped>
.wave-canvas { display: block; width: 100%; touch-action: none; }
.tool-select { cursor: text; }
.tool-shift { cursor: ew-resize; }
</style>
