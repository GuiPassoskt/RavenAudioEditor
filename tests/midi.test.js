// Testes de MIDI: leitura/escrita SMF e edição de intervalos de notas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMidi, writeMidi, pitchName } from '../src/audio/midifile.js'
import { clipNotes, insertNotes, notesEnd, quantize, removeRange } from '../src/audio/notes.js'
import { decodeProject, encodeProject } from '../src/audio/fileio.js'

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const n = (pitch, start, dur, vel = 100) => ({ id: Math.random(), pitch, start, dur, vel })

// SMF formato 0 escrito à mão: 96 ppq, tempo 100 bpm, running status e note-on com vel 0.
function handMadeSmf () {
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0 // tamanho preenchido abaixo
  ]
  const trk = [
    0x00, 0xff, 0x03, 4, 0x54, 0x65, 0x73, 0x74, // nome "Test"
    0x00, 0xff, 0x51, 3, 0x09, 0x27, 0xc0, // 600000 µs/semínima = 100 bpm
    0x00, 0xc0, 33, // programa 33 (baixo)
    0x00, 0x90, 60, 90, // C4 on
    0x60, 60, 0, // +96 ticks: C4 off via running status (vel 0)
    0x00, 64, 80, // E4 on (running status)
    0x30, 0x80, 64, 0, // +48 ticks: E4 off
    0x00, 0xff, 0x2f, 0
  ]
  const len = trk.length
  bytes.splice(18, 4, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255)
  return new Uint8Array([...bytes, ...trk]).buffer
}

test('lê SMF com mapa de andamento e running status', () => {
  const { tempo, tracks } = parseMidi(handMadeSmf())
  assert.equal(tempo, 100)
  assert.equal(tracks.length, 1)
  const t = tracks[0]
  assert.equal(t.name, 'Test')
  assert.equal(t.program, 33)
  assert.equal(t.notes.length, 2)
  close(t.notes[0].dur, 0.6) // 96 ticks = 1 semínima a 100 bpm
  close(t.notes[1].start, 0.6)
  close(t.notes[1].dur, 0.3)
  assert.equal(t.notes[1].vel, 80)
})

test('escreve e relê MIDI preservando notas, programa e bateria', async () => {
  const tracks = [
    { name: 'Piano', offset: 0.5, program: 0, drum: false, notes: [n(60, 0, 0.5, 100), n(67, 0.5, 0.25, 64)] },
    { name: 'Bateria', offset: 0, program: 0, drum: true, notes: [n(36, 0, 0.1)] }
  ]
  const blob = writeMidi(tracks, 90)
  const back = parseMidi(await blob.arrayBuffer())
  close(back.tempo, 90, 0.01)
  assert.equal(back.tracks.length, 2)
  const piano = back.tracks.find(t => !t.drum)
  close(piano.notes[0].start, 0.5) // o offset da faixa vai para o arquivo
  close(piano.notes[1].dur, 0.25)
  assert.equal(piano.notes[1].vel, 64)
  assert.ok(back.tracks.find(t => t.drum).channel === 9)
})

test('recortar/limpar/inserir notas como o NoteTrack', () => {
  const notes = [n(60, 0, 1), n(62, 1.5, 1), n(64, 3, 1)]
  // Clear de [1, 2): a nota de 1.5 é cortada; o resto anda 1 s para a esquerda.
  const cleared = removeRange(notes, 1, 2)
  assert.deepEqual(cleared.map(x => [x.pitch, x.start, x.dur]), [[60, 0, 1], [62, 1, 0.5], [64, 2, 1]])
  // Silenciar (sem deslocar).
  const gap = removeRange(notes, 1, 2, false)
  assert.deepEqual(gap.map(x => [x.pitch, x.start]), [[60, 0], [62, 2], [64, 3]])
  // Copy de [0.5, 2): pedaço de cada nota, relativo a 0.5.
  const clip = clipNotes(notes, 0.5, 2)
  assert.deepEqual(clip.map(x => [x.pitch, x.start, x.dur]), [[60, 0, 0.5], [62, 1, 0.5]])
  // Paste em 1 empurra o que vem depois.
  const pasted = insertNotes(notes, 1, clip, 1.5)
  assert.equal(pasted.length, 5)
  close(pasted.find(x => x.pitch === 64).start, 4.5)
  assert.equal(notesEnd(pasted), 5.5)
})

test('quantização alinha à grade', () => {
  const q = quantize([n(60, 0.13, 0.2), n(62, 0.37, 0.3)], 0.125, null, true)
  assert.deepEqual(q.map(x => [x.start, x.dur]), [[0.125, 0.25], [0.375, 0.25]])
})

test('projeto .ravenproj guarda faixas MIDI e o andamento', async () => {
  const project = {
    name: 'mix', rate: 44100, tempo: 96, master: { gain: 0, effects: [] },
    tracks: [{ kind: 'midi', name: 'M', offset: 1, gain: 0, pan: 0, mute: false, solo: false, program: 24, drum: false, effects: [], channels: [], notes: [n(60, 0, 1, 77)] }]
  }
  const back = await decodeProject(encodeProject(project))
  assert.equal(back.tempo, 96)
  assert.equal(back.tracks[0].kind, 'midi')
  assert.equal(back.tracks[0].notes[0].vel, 77)
  assert.equal(back.tracks[0].program, 24)
})

test('nomes de nota', () => {
  assert.equal(pitchName(60), 'C4')
  assert.equal(pitchName(69), 'A4')
})
