// Edição de intervalos de tempo em listas de notas — o que o NoteTrack do
// Audacity faz sobre o Alg_seq (lib-note-track/NoteTrack.cpp: Cut, Copy,
// Clear, Paste, Trim, Shift). Notas são objetos imutáveis
// { id, pitch, start, dur, vel }, com tempo em segundos relativo à faixa.

import { noteId } from './midifile.js'

const EPS = 1e-9

export const notesEnd = notes => notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0)

// Notas que cruzam [a, b), recortadas e com início relativo a `a`.
export function clipNotes (notes, a, b) {
  const out = []
  for (const n of notes) {
    const s = Math.max(n.start, a)
    const e = Math.min(n.start + n.dur, b)
    if (e - s > EPS) out.push({ ...n, id: noteId(), start: s - a, dur: e - s })
  }
  return out
}

// Remove [a, b). Notas que atravessam as bordas são cortadas. Com `shift`,
// o que vem depois de `b` é puxado para a esquerda (Clear); sem, fica um vão.
export function removeRange (notes, a, b, shift = true) {
  const d = shift ? b - a : 0
  const out = []
  for (const n of notes) {
    const end = n.start + n.dur
    if (end <= a + EPS) { out.push(n); continue }
    if (n.start >= b - EPS) { out.push(d ? { ...n, start: n.start - d } : n); continue }
    if (n.start < a) out.push({ ...n, dur: a - n.start })
    if (end > b) out.push({ ...n, id: noteId(), start: b - d, dur: end - b })
  }
  return out
}

// Insere `clip` (início relativo a 0, duração `dur`) em `t`, empurrando o resto.
export function insertNotes (notes, t, clip, dur) {
  const out = notes.map(n => (n.start >= t - EPS ? { ...n, start: n.start + dur } : n))
  for (const n of clip) out.push({ ...n, id: noteId(), start: n.start + t })
  return sortNotes(out)
}

export const sortNotes = notes => notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)

// Alinha o início (e opcionalmente a duração) à grade, em segundos.
export function quantize (notes, grid, ids = null, durations = false) {
  return notes.map(n => {
    if (ids && !ids.has(n.id)) return n
    const start = Math.round(n.start / grid) * grid
    const dur = durations ? Math.max(grid, Math.round(n.dur / grid) * grid) : n.dur
    return { ...n, start: Math.max(0, start), dur }
  })
}
