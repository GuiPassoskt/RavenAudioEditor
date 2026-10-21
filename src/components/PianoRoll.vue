<template>
  <div ref="root" class="piano-roll column no-wrap" tabindex="0" @keydown="onKey">
    <!-- Barra de ferramentas -->
    <div class="pr-toolbar row items-center no-wrap q-gutter-x-sm q-px-sm">
      <q-icon name="mdi-piano" size="18px" color="positive" />
      <q-select
        :model-value="ui.pianoRoll" :options="trackOptions" emit-value map-options dense dark borderless
        options-dense class="pr-track" @update:model-value="v => (ui.pianoRoll = v)"
      />
      <q-select
        v-if="track" :model-value="track.drum ? 128 : Math.floor(track.program / 8) * 8" :options="INSTRUMENTS"
        emit-value map-options dense dark borderless options-dense class="pr-instr"
        @update:model-value="v => store.setInstrument(track.id, v)"
      />
      <q-separator vertical dark inset />
      <q-input
        :model-value="store.tempo" type="number" dense dark borderless suffix="BPM" class="pr-tempo mono"
        @blur="e => store.setTempo(e.target.value)" @keyup.enter="e => e.target.blur()"
      />
      <q-select v-model="snap" :options="SNAPS" emit-value map-options dense dark borderless options-dense class="pr-snap" label="Grade" />
      <q-separator vertical dark inset />
      <q-btn-toggle
        v-model="tool" dense flat no-caps size="sm" toggle-color="primary" color="grey-5"
        :options="[{ icon: 'edit', value: 'draw', attrs: { title: 'Lápis: clique cria notas' } }, { icon: 'highlight_alt', value: 'select', attrs: { title: 'Seleção: arraste para selecionar' } }]"
      />
      <q-btn flat dense size="sm" icon="mdi-format-align-left" title="Quantizar (Q)" @click="quantizeSel" />
      <q-btn flat dense size="sm" icon="mdi-arrow-down-bold" title="Transpor -1 semitom (↓, Shift: oitava)" @click="transpose(-1)" />
      <q-btn flat dense size="sm" icon="mdi-arrow-up-bold" title="Transpor +1 semitom (↑, Shift: oitava)" @click="transpose(1)" />
      <q-btn flat dense size="sm" icon="delete" title="Excluir notas selecionadas (Delete)" :disable="!selected.size" @click="deleteSel" />
      <div class="row items-center no-wrap q-gutter-x-xs" title="Velocity das notas novas">
        <span class="text-caption text-grey-6">Vel</span>
        <q-slider v-model="newVel" :min="1" :max="127" dense dark color="positive" style="width: 70px" />
        <span class="mono text-caption">{{ newVel }}</span>
      </div>
      <q-space />
      <span class="text-caption text-grey-6 ellipsis hint">
        clique: criar · arrastar: mover · borda direita: duração · botão direito: apagar · Shift+arrastar: selecionar
      </span>
      <q-btn flat dense round size="sm" icon="zoom_out" title="Afastar (Ctrl+roda)" @click="zoom(0.8)" />
      <q-btn flat dense round size="sm" icon="zoom_in" title="Aproximar (Ctrl+roda)" @click="zoom(1.25)" />
      <q-btn flat dense round size="sm" icon="close" title="Fechar (F7)" @click="ui.pianoRoll = null" />
    </div>

    <div v-if="!track" class="q-pa-lg text-grey-6">Faixa MIDI não encontrada.</div>
    <template v-else>
      <!-- Teclado + grade -->
      <div class="pr-main row no-wrap col">
        <canvas ref="keysCv" class="pr-keys" @pointerdown="onKeysDown" @wheel.prevent="onWheel" />
        <div ref="gridWrap" class="pr-grid-wrap col">
          <canvas ref="gridCv" class="pr-grid" :class="`tool-${tool}`" @pointerdown="onGridDown" @pointermove="onGridHover" @contextmenu.prevent @wheel.prevent="onWheel" />
          <div v-if="playheadX !== null" class="pr-playhead" :style="{ left: playheadX + 'px' }" />
        </div>
      </div>
      <!-- Velocity -->
      <div class="pr-vel row no-wrap">
        <div class="pr-vel-label text-caption text-grey-6">Velocity</div>
        <canvas ref="velCv" class="pr-vel-cv col" @pointerdown="onVelDown" />
      </div>
    </template>
  </div>
</template>

<script setup>
// Piano roll para faixas MIDI. O Audacity mostra Note Tracks
// (src/tracks/playabletrack/notetrack/ui/NoteTrackView.cpp) mas não permite
// editar notas individualmente; aqui é um editor completo. Toda alteração passa
// por store.setTrackNotes, então entra no histórico de desfazer.

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { keyName, useCommands } from 'src/composables/commands'
import { INSTRUMENTS } from 'src/audio/synth'
import { engine } from 'src/audio/engine'
import { isBlackKey, noteId, pitchName } from 'src/audio/midifile'
import { quantize } from 'src/audio/notes'
import { shade } from 'src/audio/colors'

const KEY_H = 13
const KEYS_W = 64
const VEL_H = 64
const SNAPS = [
  { label: '1 compasso', value: 4 }, { label: '1/4 (semínima)', value: 1 }, { label: '1/8', value: 0.5 },
  { label: '1/8 tercina', value: 1 / 3 }, { label: '1/16', value: 0.25 }, { label: '1/32', value: 0.125 }, { label: 'Livre', value: 0 }
]

const store = useProjectStore()
const ui = useUiStore()
const { exec, keymap } = useCommands()

const root = ref(null)
const keysCv = ref(null)
const gridCv = ref(null)
const gridWrap = ref(null)
const velCv = ref(null)

const ppb = ref(60) // pixels por batida
const scrollBeat = ref(0)
const scrollY = ref(0)
const snap = ref(0.25)
const tool = ref('draw')
const newVel = ref(100)
const lastDur = ref(1) // em batidas
const selected = reactive(new Set())
const selVersion = ref(0)
const box = ref(null)
const hoverPitch = ref(null)
const size = reactive({ w: 0, h: 0 })
let noteClipboard = null

const track = computed(() => store.findTrack(ui.pianoRoll))
const trackOptions = computed(() => store.midiTracks.map(t => ({ label: t.name, value: t.id })))
const spb = computed(() => 60 / store.tempo) // segundos por batida

const beatOfSec = s => s / spb.value
const secOfBeat = b => b * spb.value
const xOfBeat = b => (b - scrollBeat.value) * ppb.value
const beatOfX = x => x / ppb.value + scrollBeat.value
const yOfPitch = p => (127 - p) * KEY_H - scrollY.value
const pitchOfY = y => Math.max(0, Math.min(127, 127 - Math.floor((y + scrollY.value) / KEY_H)))
const snapBeat = (b, mode = 'round') => (snap.value ? Math[mode](b / snap.value) * snap.value : b)
const noteBeat = n => beatOfSec(track.value.offset + n.start)

const playheadX = computed(() => {
  if (store.playhead === null || !track.value) return null
  const x = xOfBeat(beatOfSec(store.playhead))
  return x < 0 || x > size.w ? null : x
})

const markSel = () => { selVersion.value++ }

// ---------- Desenho ----------
let frame = 0
const schedule = () => { if (!frame) frame = requestAnimationFrame(drawAll) }

function prep (cv, w, h) {
  const dpr = window.devicePixelRatio || 1
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  cv.style.height = h + 'px'
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return g
}

function drawAll () {
  frame = 0
  if (!track.value || !gridCv.value) return
  drawGrid()
  drawKeys()
  drawVel()
}

function drawGrid () {
  const { w, h } = size
  const g = prep(gridCv.value, w, h)
  // Linhas de teclas (pretas mais escuras).
  const pTop = pitchOfY(0)
  const pBottom = pitchOfY(h)
  for (let p = pBottom; p <= pTop; p++) {
    const y = yOfPitch(p)
    g.fillStyle = isBlackKey(p) ? '#150f20' : '#1d1530'
    g.fillRect(0, y, w, KEY_H)
    if (p % 12 === 0) { g.fillStyle = '#3a2b58'; g.fillRect(0, y + KEY_H - 1, w, 1) }
  }
  // Seleção de tempo do projeto.
  const { t0, t1 } = store.sel
  if (t1 > t0) {
    g.fillStyle = 'rgba(139,92,246,0.10)'
    g.fillRect(xOfBeat(beatOfSec(t0)), 0, (beatOfSec(t1) - beatOfSec(t0)) * ppb.value, h)
  }
  // Grade vertical: compassos (4/4), batidas e subdivisões.
  const b0 = Math.floor(beatOfX(0))
  const b1 = Math.ceil(beatOfX(w))
  const sub = snap.value && snap.value < 1 && snap.value * ppb.value >= 6 ? snap.value : null
  for (let b = b0; b <= b1; b++) {
    const x = Math.round(xOfBeat(b)) + 0.5
    g.fillStyle = b % 4 === 0 ? '#5a4880' : '#2f2446'
    g.fillRect(x, 0, 1, h)
    if (sub) {
      g.fillStyle = '#231a35'
      for (let s = sub; s < 1 - 1e-6; s += sub) g.fillRect(Math.round(xOfBeat(b + s)) + 0.5, 0, 1, h)
    }
    if (b % 4 === 0 && b >= 0) {
      g.fillStyle = '#9a8db5'
      g.font = '10px Roboto, sans-serif'
      g.fillText(String(b / 4 + 1), x + 3, 10)
    }
  }
  // Notas.
  const color = track.value.color || '#2fbf8a'
  const offBeat = beatOfSec(track.value.offset)
  for (const n of track.value.notes) {
    const nb = offBeat + beatOfSec(n.start)
    const x = xOfBeat(nb)
    const nw = Math.max(3, beatOfSec(n.dur) * ppb.value)
    if (x > w || x + nw < 0) continue
    const y = yOfPitch(n.pitch)
    if (y > h || y + KEY_H < 0) continue
    const sel = selected.has(n.id)
    // Cor da faixa; velocity mais alta = tom mais claro. Selecionadas ficam quase brancas.
    g.fillStyle = sel ? shade(color, 0.7) : shade(color, -0.15 + (n.vel / 127) * 0.4)
    g.fillRect(x + 0.5, y + 1, nw - 1, KEY_H - 2)
    g.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.45)'
    g.strokeRect(x + 0.5, y + 1.5, nw - 1, KEY_H - 3)
    if (nw > 28) {
      g.fillStyle = 'rgba(0,0,0,0.7)'
      g.font = '9px Roboto, sans-serif'
      g.fillText(pitchName(n.pitch), x + 3, y + KEY_H - 3.5)
    }
  }
  // Caixa de seleção.
  if (box.value) {
    const { x0, y0, x1, y1 } = box.value
    g.fillStyle = 'rgba(139,92,246,0.15)'
    g.strokeStyle = '#8b5cf6'
    g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
  }
}

function drawKeys () {
  const h = size.h
  const g = prep(keysCv.value, KEYS_W, h)
  g.fillStyle = '#0b0812'
  g.fillRect(0, 0, KEYS_W, h)
  for (let p = pitchOfY(h); p <= pitchOfY(0); p++) {
    const y = yOfPitch(p)
    const black = isBlackKey(p)
    g.fillStyle = p === hoverPitch.value ? '#8b5cf6' : black ? '#222' : '#e8e8e8'
    g.fillRect(black ? 0 : 0, y, black ? KEYS_W * 0.62 : KEYS_W, KEY_H - (black ? 0 : 1))
    if (p % 12 === 0) {
      g.fillStyle = '#333'
      g.font = '9px Roboto, sans-serif'
      g.fillText(pitchName(p), KEYS_W - 24, y + KEY_H - 3)
    }
  }
}

function drawVel () {
  const w = size.w
  const g = prep(velCv.value, w, VEL_H)
  g.fillStyle = '#0f0b17'
  g.fillRect(0, 0, w, VEL_H)
  g.fillStyle = '#231a35'
  g.fillRect(0, VEL_H / 2, w, 1)
  const offBeat = beatOfSec(track.value.offset)
  for (const n of track.value.notes) {
    const x = xOfBeat(offBeat + beatOfSec(n.start))
    if (x < -4 || x > w) continue
    const bh = (n.vel / 127) * (VEL_H - 6)
    g.fillStyle = selected.has(n.id) ? shade(track.value.color || '#2fbf8a', 0.7) : (track.value.color || '#2fbf8a')
    g.fillRect(x, VEL_H - bh, 3, bh)
    g.fillRect(x - 2, VEL_H - bh, 7, 2)
  }
}

// ---------- Edição ----------
const notes = () => track.value.notes
const commit = desc => store.pushState(desc)
const live = list => store.setTrackNotes(track.value.id, list)

function hitTest (x, y) {
  const offBeat = beatOfSec(track.value.offset)
  const list = notes()
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i]
    const nx = xOfBeat(offBeat + beatOfSec(n.start))
    const nw = Math.max(3, beatOfSec(n.dur) * ppb.value)
    const ny = yOfPitch(n.pitch)
    if (x >= nx && x <= nx + nw && y >= ny && y < ny + KEY_H) {
      return { note: n, edge: nw > 10 && nx + nw - x < 6 }
    }
  }
  return null
}

function audition (pitch, vel = newVel.value) {
  const t = track.value
  engine.auditionNote(store.rate, pitch, t.program, t.drum, vel)
}

function localPos (e, el) {
  const r = el.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function onGridHover (e) {
  const { x, y } = localPos(e, gridCv.value)
  const p = pitchOfY(y)
  if (p !== hoverPitch.value) { hoverPitch.value = p; schedule() }
  const hit = hitTest(x, y)
  gridCv.value.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'move') : ''
}

function onGridDown (e) {
  root.value.focus()
  const t = track.value
  const start = localPos(e, gridCv.value)
  const hit = hitTest(start.x, start.y)

  if (e.button === 2) {
    if (!hit) return
    const ids = selected.has(hit.note.id) ? new Set(selected) : new Set([hit.note.id])
    live(notes().filter(n => !ids.has(n.id)))
    ids.forEach(id => selected.delete(id))
    commit(ids.size > 1 ? 'Notas excluídas' : 'Nota excluída')
    markSel()
    return
  }
  if (e.button !== 0) return

  let mode
  let anchor
  let desc
  const originals = notes()

  if (hit) {
    if (e.shiftKey && selected.has(hit.note.id)) { selected.delete(hit.note.id); markSel(); schedule(); return }
    if (!selected.has(hit.note.id)) { if (!e.shiftKey) selected.clear(); selected.add(hit.note.id) }
    anchor = hit.note
    mode = hit.edge ? 'resize' : 'move'
    desc = mode === 'move' ? 'Notas movidas' : 'Duração alterada'
    if (mode === 'move') audition(anchor.pitch, anchor.vel)
  } else if (tool.value === 'draw' && !e.shiftKey) {
    const beat = Math.max(0, snapBeat(beatOfX(start.x), 'floor'))
    const n = {
      id: noteId(), pitch: pitchOfY(start.y),
      start: secOfBeat(beat) - t.offset, dur: secOfBeat(lastDur.value), vel: newVel.value
    }
    if (n.start < 0) { t.offset += n.start; n.start = 0 } // nota antes do início da faixa
    selected.clear()
    selected.add(n.id)
    live([...originals, n])
    anchor = n
    mode = 'resize'
    desc = 'Nota adicionada'
    audition(n.pitch)
  } else {
    mode = 'box'
    if (!e.shiftKey) selected.clear()
  }
  markSel()
  schedule()

  const base = notes() // inclui a nota recém-criada
  const baseSel = new Set(selected)
  let changed = desc === 'Nota adicionada'
  let lastPitch = anchor?.pitch

  const onMove = ev => {
    const p = localPos(ev, gridCv.value)
    if (mode === 'box') {
      box.value = { x0: start.x, y0: start.y, x1: p.x, y1: p.y }
      const bx0 = beatOfX(Math.min(start.x, p.x))
      const bx1 = beatOfX(Math.max(start.x, p.x))
      const pHi = pitchOfY(Math.min(start.y, p.y))
      const pLo = pitchOfY(Math.max(start.y, p.y))
      selected.clear()
      baseSel.forEach(id => selected.add(id))
      for (const n of notes()) {
        const nb = noteBeat(n)
        if (nb < bx1 && nb + beatOfSec(n.dur) > bx0 && n.pitch >= pLo && n.pitch <= pHi) selected.add(n.id)
      }
      markSel()
      schedule()
      return
    }
    const dBeat = beatOfX(p.x) - beatOfX(start.x)
    if (mode === 'move') {
      const anchorBeat = noteBeat(anchor)
      let delta = snapBeat(anchorBeat + dBeat) - anchorBeat
      // Não deixa nenhuma nota selecionada ir antes do tempo 0.
      const minBeat = Math.min(...base.filter(n => selected.has(n.id)).map(noteBeat))
      delta = Math.max(delta, -minBeat)
      const dPitch = Math.round((start.y - p.y) / KEY_H)
      const dSec = secOfBeat(delta)
      live(base.map(n => (selected.has(n.id)
        ? { ...n, start: n.start + dSec, pitch: Math.max(0, Math.min(127, n.pitch + dPitch)) }
        : n)))
      const np = Math.max(0, Math.min(127, anchor.pitch + dPitch))
      if (np !== lastPitch) { lastPitch = np; audition(np, anchor.vel) }
      changed = changed || delta !== 0 || dPitch !== 0
    } else {
      const endBeat = noteBeat(anchor) + beatOfSec(anchor.dur)
      const newEnd = snapBeat(endBeat + dBeat)
      const minDur = secOfBeat(snap.value || 0.0625)
      const dSec = secOfBeat(newEnd - endBeat)
      live(base.map(n => (selected.has(n.id) ? { ...n, dur: Math.max(minDur, n.dur + dSec) } : n)))
      changed = changed || dSec !== 0
    }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (mode === 'box') { box.value = null; schedule(); return }
    if (changed) {
      const a = notes().find(n => n.id === anchor.id)
      if (a && mode === 'resize') lastDur.value = beatOfSec(a.dur)
      commit(desc)
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onKeysDown (e) {
  const { y } = localPos(e, keysCv.value)
  audition(pitchOfY(y))
}

function onVelDown (e) {
  root.value.focus()
  const { x } = localPos(e, velCv.value)
  const offBeat = beatOfSec(track.value.offset)
  let best = null
  let bestDist = 8
  for (const n of notes()) {
    const d = Math.abs(xOfBeat(offBeat + beatOfSec(n.start)) - x)
    if (d < bestDist || (d === bestDist && selected.has(n.id))) { best = n; bestDist = d }
  }
  if (!best) return
  const ids = selected.has(best.id) ? new Set(selected) : new Set([best.id])
  const base = notes()
  const apply = ev => {
    const { y } = localPos(ev, velCv.value)
    const vel = Math.max(1, Math.min(127, Math.round((VEL_H - y) / (VEL_H - 6) * 127)))
    live(base.map(n => (ids.has(n.id) ? { ...n, vel } : n)))
  }
  apply(e)
  const onUp = () => {
    window.removeEventListener('pointermove', apply)
    window.removeEventListener('pointerup', onUp)
    commit('Velocity alterada')
  }
  window.addEventListener('pointermove', apply)
  window.addEventListener('pointerup', onUp)
}

function mapSelected (fn, desc) {
  if (!selected.size) return
  live(notes().map(n => (selected.has(n.id) ? fn(n) : n)))
  commit(desc)
}

function deleteSel () {
  if (!selected.size) return
  live(notes().filter(n => !selected.has(n.id)))
  selected.clear()
  markSel()
  commit('Notas excluídas')
}

function transpose (d) {
  mapSelected(n => ({ ...n, pitch: Math.max(0, Math.min(127, n.pitch + d)) }), 'Notas transpostas')
}

function nudge (dir) {
  const dSec = secOfBeat(dir * (snap.value || 0.25))
  const minStart = Math.min(...notes().filter(n => selected.has(n.id)).map(n => track.value.offset + n.start))
  if (minStart + dSec < 0) return
  mapSelected(n => ({ ...n, start: n.start + dSec }), 'Notas movidas')
}

function quantizeSel () {
  const grid = secOfBeat(snap.value || 0.25)
  const ids = selected.size ? new Set(selected) : null
  // A grade é absoluta (tempo do projeto), então compensa o offset da faixa.
  const off = track.value.offset
  const shifted = notes().map(n => ({ ...n, start: n.start + off }))
  live(quantize(shifted, grid, ids).map(n => ({ ...n, start: n.start - off })))
  commit('Notas quantizadas')
}

function selectedNotes () {
  return notes().filter(n => selected.has(n.id))
}

function duplicateSel () {
  const sel = selectedNotes()
  if (!sel.length) return
  const s0 = Math.min(...sel.map(n => n.start))
  const s1 = Math.max(...sel.map(n => n.start + n.dur))
  const span = secOfBeat(snapBeat(beatOfSec(s1 - s0), 'ceil') || beatOfSec(s1 - s0))
  const copies = sel.map(n => ({ ...n, id: noteId(), start: n.start + span }))
  live([...notes(), ...copies])
  selected.clear()
  copies.forEach(n => selected.add(n.id))
  markSel()
  commit('Notas duplicadas')
}

function copySel () {
  const sel = selectedNotes()
  if (!sel.length) return
  const s0 = Math.min(...sel.map(n => n.start))
  noteClipboard = sel.map(n => ({ ...n, start: n.start - s0 }))
}

function pasteNotes () {
  if (!noteClipboard) return
  const at = Math.max(0, (store.playhead ?? store.sel.t0) - track.value.offset)
  const pasted = noteClipboard.map(n => ({ ...n, id: noteId(), start: n.start + at }))
  live([...notes(), ...pasted])
  selected.clear()
  pasted.forEach(n => selected.add(n.id))
  markSel()
  commit('Notas coladas')
}

// Teclado: o piano roll trata as próprias teclas; as demais seguem para os
// atalhos globais (Espaço toca, Ctrl+Z desfaz, etc.).
function onKey (e) {
  if (e.target.closest('input, textarea, .q-field')) return
  const name = keyName(e)
  if (!name) return
  const local = {
    Delete: deleteSel,
    Backspace: deleteSel,
    'Ctrl+A': () => { notes().forEach(n => selected.add(n.id)); markSel() },
    Escape: () => { selected.clear(); markSel() },
    ArrowUp: () => transpose(1),
    ArrowDown: () => transpose(-1),
    'Shift+ArrowUp': () => transpose(12),
    'Shift+ArrowDown': () => transpose(-12),
    ArrowLeft: () => nudge(-1),
    ArrowRight: () => nudge(1),
    'Ctrl+D': duplicateSel,
    'Ctrl+C': copySel,
    'Ctrl+V': pasteNotes,
    Q: quantizeSel
  }
  if (local[name]) {
    e.preventDefault()
    e.stopPropagation()
    local[name]()
    schedule()
    return
  }
  const id = keymap.get(name)
  if (id) {
    e.preventDefault()
    e.stopPropagation()
    exec(id)
  }
}

// ---------- Navegação ----------
function zoom (f, anchorX = size.w / 2) {
  const b = beatOfX(anchorX)
  ppb.value = Math.max(8, Math.min(600, ppb.value * f))
  scrollBeat.value = Math.max(0, b - anchorX / ppb.value)
}

function onWheel (e) {
  if (e.ctrlKey || e.metaKey) {
    const { x } = localPos(e, gridCv.value)
    zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, x)
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    scrollBeat.value = Math.max(0, scrollBeat.value + (e.deltaX || e.deltaY) / ppb.value)
  } else {
    scrollY.value = Math.max(0, Math.min(128 * KEY_H - size.h, scrollY.value + e.deltaY))
  }
}

// Centraliza as notas da faixa ao abrir.
function frameTrack () {
  const t = track.value
  if (!t) return
  const list = t.notes
  const center = list.length ? list.reduce((s, n) => s + n.pitch, 0) / list.length : 60
  scrollY.value = Math.max(0, (127 - center) * KEY_H - size.h / 2)
  scrollBeat.value = list.length ? Math.max(0, Math.floor(beatOfSec(t.offset + list[0].start)) - 1) : Math.max(0, Math.floor(beatOfSec(store.sel.t0)))
  selected.clear()
  markSel()
}

// Segue o cursor de reprodução.
watch(() => store.playhead, p => {
  if (p === null || !track.value) return
  const b = beatOfSec(p)
  if (b > beatOfX(size.w) || b < scrollBeat.value) scrollBeat.value = Math.max(0, b - 1)
})

watch(() => [track.value?.version, track.value?.notes, track.value?.color, ppb.value, scrollBeat.value, scrollY.value, selVersion.value,
  store.tempo, snap.value, store.sel.t0, store.sel.t1, size.w, size.h, track.value?.offset], schedule)

watch(() => ui.pianoRoll, async () => { await nextTick(); measure(); frameTrack(); schedule() })

let observer = null
function measure () {
  if (!gridWrap.value) return
  size.w = gridWrap.value.clientWidth
  size.h = gridWrap.value.clientHeight
}

onMounted(async () => {
  await nextTick()
  observer = new ResizeObserver(() => { measure(); schedule() })
  if (gridWrap.value) observer.observe(gridWrap.value)
  measure()
  frameTrack()
  schedule()
  root.value?.focus()
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame) })
</script>

<style scoped>
.piano-roll { height: 46vh; min-height: 300px; flex: none; background: var(--ed-bg); border-top: 2px solid var(--ed-border); outline: none; }
.piano-roll:focus-within { border-top-color: #8b5cf6; }
.pr-toolbar { height: 38px; background: var(--ed-panel); border-bottom: 1px solid var(--ed-border); overflow: hidden; }
.pr-track { width: 170px; }
.pr-instr { width: 160px; }
.pr-tempo { width: 92px; }
.pr-snap { width: 120px; }
.pr-toolbar :deep(.q-field__control), .pr-toolbar :deep(.q-field__native) { min-height: 30px; font-size: 12px; }
.hint { max-width: 520px; }
.pr-main { min-height: 0; }
.pr-keys { width: 64px; flex: none; display: block; cursor: pointer; border-right: 1px solid #000; }
.pr-grid-wrap { position: relative; min-width: 0; overflow: hidden; }
.pr-grid { display: block; width: 100%; }
.tool-draw { cursor: crosshair; }
.tool-select { cursor: default; }
.pr-playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--ed-playhead); pointer-events: none; box-shadow: 0 0 6px var(--ed-playhead); }
.pr-vel { height: 64px; flex: none; border-top: 1px solid var(--ed-border); }
.pr-vel-label { width: 64px; flex: none; display: flex; align-items: center; justify-content: center; background: var(--ed-panel); }
.pr-vel-cv { display: block; height: 64px; cursor: ns-resize; min-width: 0; }
</style>
