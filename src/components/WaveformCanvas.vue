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
//
// Com a ferramenta de envelope (F3), edita a automação de volume ou pan da faixa
// como o EnvelopeHandle do Audacity: clicar cria um ponto, arrastar move, duplo
// clique remove.

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isFrozen, useProjectStore } from 'src/stores/project'
import { AUTOMATION_PARAMS, envelopeAt, hasAutomation } from 'src/audio/automation'
import { rangeStats } from 'src/audio/summary'
import { trackDuration } from 'src/audio/engine'
import { useUiStore } from 'src/stores/ui'
import { rgba, shade, textOn } from 'src/audio/colors'

const CLIP_HEADER = 15 // faixa de título do clip, como nas DAWs
const ENVELOPE_HIT = 8 // px: distância para pegar um ponto do envelope

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
let ghost = null // { t0, t1 } do clipe arrastado com a ferramenta de mover

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
  const isBus = track.kind === 'bus'
  const len = track.kind === 'audio' ? track.channels[0].length : 0
  // Clips em pixels: no áudio, as regiões do buffer (clips.js); no MIDI, a faixa
  // inteira, se tiver notas.
  const regions = track.kind === 'audio'
    ? track.clips.map(c => [xOf(track.offset + c.s0 / rate), xOf(track.offset + c.s1 / rate)])
    : isMidi && track.notes.length ? [[xOf(track.offset), xOf(track.offset + trackDuration(track, rate))]] : []
  const visible = regions.filter(([a, b]) => b > 0 && a < w)
  const hasClip = visible.length > 0
  const frozen = isFrozen(track)
  for (const [rawX0, rawX1] of visible) {
    const x = Math.max(-4, rawX0) + 1
    const cw = Math.max(1, Math.min(w + 4, rawX1) - x - 1)
    g.save()
    g.beginPath()
    g.roundRect(x, 2, cw, h - 4, Math.min(4, cw / 2))
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
    g.fillText(frozen ? `❄ ${track.name} (congelada)` : track.name, Math.max(x, 0) + 6, 2 + CLIP_HEADER / 2 + 0.5)
    g.textBaseline = 'alphabetic'
    // Congelada: um véu frio sobre o clipe.
    if (frozen) {
      g.fillStyle = 'rgba(160, 210, 255, 0.10)'
      g.fillRect(x, 2 + CLIP_HEADER, cw, h - 4 - CLIP_HEADER)
    }
    g.restore()
  }
  // Clipe sendo arrastado com a ferramenta de mover: contorno na posição nova.
  if (ghost) {
    const a = xOf(ghost.t0)
    g.save()
    g.strokeStyle = colors.cursor
    g.setLineDash([4, 3])
    g.strokeRect(a + 0.5, 2.5, Math.max(1, (ghost.t1 - ghost.t0) * pps - 1), h - 5)
    g.restore()
  }
  if (isBus) {
    g.fillStyle = rgba(color, 0.12)
    g.fillRect(0, 2, w, h - 4)
    g.fillStyle = rgba(color, 0.85)
    g.font = '11px Roboto, sans-serif'
    const from = store.tracks.filter(t => t.sends?.some(s => s.bus === track.id)).length
    g.fillText(`Barramento — recebe ${from === 1 ? '1 envio' : from + ' envios'}. Efeitos e volume do barramento valem para todos.`, 10, 18)
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

  if (isMidi) {
    const [mx0, mx1] = visible[0] ?? [0, 0]
    drawNotes(g, w, top0, contentH, xOf, color, Math.max(0, mx0), Math.min(w, mx1))
  }

  const nCh = Math.max(1, track.channels.length)
  const laneH = contentH / nCh
  const spp = rate / pps // amostras por pixel

  track.channels.forEach((ch, c) => {
    const top = top0 + c * laneH
    const mid = top + laneH / 2
    const half = laneH / 2 - 2

    // Só dentro dos clips: fora deles o buffer é silêncio.
    for (const [rx0, rx1] of visible) {
      const clipX0 = Math.max(0, rx0)
      const clipX1 = Math.min(w, rx1)
      g.fillStyle = axisColor
      g.fillRect(clipX0, Math.round(mid), clipX1 - clipX0, 1)
      if (c > 0) g.fillRect(clipX0, Math.round(top), clipX1 - clipX0, 1)
      if (!len) continue

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
        const s0 = Math.max(0, Math.floor((scrollTime + clipX0 / pps - track.offset) * rate) - 1)
        const s1 = Math.min(len, Math.ceil((scrollTime + clipX1 / pps - track.offset) * rate) + 1)
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
    }
  })

  // Automação: a linha do parâmetro escolhido com a ferramenta de envelope; fora
  // dela, as linhas que existirem, mais apagadas.
  const envTop = isBus ? 26 : CLIP_HEADER + 4
  const envH = h - envTop - 3
  const editing = store.tool === 'envelope'
  for (const param of ['gain', 'pan']) {
    const active = editing && ui.envelopeParam === param
    if (active || track.automation?.[param]?.length) drawEnvelope(g, w, envTop, envH, xOf, param, active)
  }

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

// Valor do parâmetro <-> altura na área do envelope.
function envelopeY (param, v, top, h) {
  const { min, max } = AUTOMATION_PARAMS[param]
  return top + ((max - v) / (max - min)) * h
}
function envelopeValue (param, y, top, h) {
  const { min, max } = AUTOMATION_PARAMS[param]
  const v = max - ((y - top) / h) * (max - min)
  return param === 'gain' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100
}

function drawEnvelope (g, w, top, h, xOf, param, active) {
  const track = props.track
  const points = track.automation?.[param] ?? []
  const color = param === 'gain' ? '#ffd166' : '#5ee0c8'
  g.save()
  g.globalAlpha = active ? 1 : 0.55
  g.strokeStyle = color
  g.lineWidth = active ? 1.5 : 1
  if (!points.length) {
    // Sem pontos: a linha neutra (0 dB, ou o pan da faixa), tracejada.
    const y = envelopeY(param, AUTOMATION_PARAMS[param].neutral(track), top, h)
    g.setLineDash([4, 4])
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke()
    g.setLineDash([])
  } else {
    g.beginPath()
    const x0 = Math.max(0, xOf(track.offset + points[0].t))
    g.moveTo(0, envelopeY(param, points[0].v, top, h))
    for (const p of points) g.lineTo(xOf(track.offset + p.t), envelopeY(param, p.v, top, h))
    g.lineTo(w, envelopeY(param, points[points.length - 1].v, top, h))
    g.stroke()
    if (active) {
      g.fillStyle = color
      for (const p of points) {
        const x = xOf(track.offset + p.t)
        if (x < x0 - 6 || x > w + 6) continue
        g.beginPath(); g.arc(x, envelopeY(param, p.v, top, h), 3.5, 0, Math.PI * 2); g.fill()
      }
    }
  }
  if (active) {
    g.fillStyle = color
    g.font = '10px Roboto, sans-serif'
    const label = param === 'gain' ? 'Volume (dB, somado ao fader)' : 'Pan (D em cima, E embaixo)'
    g.fillText(label, w - g.measureText(label).width - 8, top + 11)
  }
  g.restore()
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

// Área do envelope e pontos em pixels, para achar o ponto sob o mouse.
function envelopeGeometry () {
  const track = props.track
  const rect = canvas.value.getBoundingClientRect()
  const top = track.kind === 'bus' ? 26 : CLIP_HEADER + 4
  const h = props.height - top - 3
  const param = ui.envelopeParam
  const points = [...(track.automation?.[param] ?? [])]
  const xOf = t => (track.offset + t - store.scrollTime) * store.pps
  return { rect, top, h, param, points, xOf }
}

function nearestPoint ({ rect, top, h, param, points, xOf }, e) {
  let best = -1
  let bestD = ENVELOPE_HIT
  points.forEach((p, i) => {
    const d = Math.hypot(xOf(p.t) - (e.clientX - rect.left), envelopeY(param, p.v, top, h) - (e.clientY - rect.top))
    if (d <= bestD) { best = i; bestD = d }
  })
  return best
}

function onEnvelopeDown (e) {
  const track = props.track
  store.selectTrack(track.id)
  const geo = envelopeGeometry()
  const { rect, top, h, param } = geo
  const local = ev => ({
    t: Math.max(0, store.scrollTime + (ev.clientX - rect.left) / store.pps - track.offset),
    v: envelopeValue(param, Math.max(top, Math.min(top + h, ev.clientY - rect.top)), top, h)
  })
  let points = geo.points.map(p => ({ ...p })) // os pontos do store estão no histórico: não mexer neles
  let i = nearestPoint(geo, e)
  const created = i < 0
  if (created) {
    // Ponto novo onde se clicou. Numa linha vazia, ou clicando em cima da linha,
    // ele nasce no valor da linha (o som não muda até arrastar).
    const p = local(e)
    if (!points.length) p.v = AUTOMATION_PARAMS[param].neutral(track)
    else if (Math.abs(envelopeY(param, envelopeAt(points, p.t), top, h) - (e.clientY - rect.top)) <= ENVELOPE_HIT) p.v = Math.round(envelopeAt(points, p.t) * 100) / 100
    points = [...points, p]
    i = points.length - 1
  }
  const dragged = points[i]
  let changed = created
  const update = p => {
    points = points.map(x => (x === dragged ? Object.assign(dragged, p) : x))
    store.setAutomation(track.id, param, points.map(x => ({ ...x })))
  }
  if (created) update({})
  const onMove = ev => {
    changed = true
    update(local(ev))
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (changed) store.commitAutomation(param)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onPointerDown (e) {
  if (e.button !== 0) return
  const track = props.track
  const t = timeAt(e.clientX)
  let onMove

  if (store.tool === 'envelope') {
    onEnvelopeDown(e)
    return
  }

  if (store.tool === 'shift' && track.kind === 'audio' && track.clips.length > 1) {
    store.selectTrack(track.id, e.ctrlKey || e.metaKey)
    const clip = store.clipAtTime(track, t)
    if (!clip) return
    const startX = e.clientX
    const dur = clip.t1 - clip.t0
    onMove = ev => {
      const t0 = Math.max(0, clip.t0 + (ev.clientX - startX) / store.pps)
      ghost = { t0, t1: t0 + dur }
      scheduleDraw()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const to = ghost?.t0
      ghost = null
      scheduleDraw()
      if (to !== undefined && to !== clip.t0) store.moveClip(track.id, clip.index, to)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return
  }

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

function onDoubleClick (e) {
  const t = props.track
  if (store.tool === 'envelope') {
    // Duplo clique num ponto remove o ponto.
    const geo = envelopeGeometry()
    const i = nearestPoint(geo, e)
    if (i >= 0) store.setAutomation(t.id, geo.param, geo.points.filter((_, k) => k !== i), 'Ponto de automação removido')
    return
  }
  if (t.kind === 'bus') return
  if (t.kind === 'midi') { store.selectTrack(t.id); ui.pianoRoll = t.id; return }
  store.selectTrack(t.id)
  const clip = store.clipAtTime(t, timeAt(e.clientX))
  if (clip) store.setSelection(clip.t0, clip.t1)
  else store.setSelection(t.offset, store.trackEnd(t))
}

watch(
  () => [props.track.version, props.track.offset, props.track.selected, props.track.channels, props.track.clips, props.track.notes, props.track.color, props.track.name, store.recTake,
    props.track.automation, props.track.frozen, props.track.effects, props.track.pan, store.tool, ui.envelopeParam,
    props.track.kind === 'bus' && store.tracks.map(t => t.sends),
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
.tool-envelope { cursor: crosshair; }
</style>
