// Testes dos clips (Fase 5): regiões do buffer da faixa de áudio.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/audio/clips.js'
import { decodeProject, encodeProject } from '../src/audio/fileio.js'

const clips = (...pairs) => pairs.map(([s0, s1]) => ({ s0, s1 }))

test('normalizar: ordena, corta nas pontas, junta só o que se sobrepõe', () => {
  assert.deepEqual(C.normalizeClips(clips([50, 120], [0, 10], [5, 20], [20, 30]), 100), clips([0, 20], [20, 30], [50, 100]))
  assert.deepEqual(C.wholeClips(0), [])
})

test('dividir e juntar', () => {
  const split = C.splitClips(clips([0, 100]), [30, 60, 100])
  assert.deepEqual(split, clips([0, 30], [30, 60], [60, 100]))
  assert.deepEqual(C.joinClips(split, 10, 70), clips([0, 100]))
  assert.deepEqual(C.joinClips(split, 10, 20), split) // um clipe só: nada muda
  assert.deepEqual(C.joinClips(clips([0, 10], [50, 60]), 5, 55), clips([0, 60])) // o vão vira parte do clipe
})

test('excluir puxa o resto; excluir deixando vão não puxa', () => {
  const two = clips([0, 40], [60, 100])
  assert.deepEqual(C.removeClipRange(two, 30, 70), clips([0, 30], [30, 60]))
  assert.deepEqual(C.removeClipRange(two, 40, 60), clips([0, 40], [40, 80]))
  assert.deepEqual(C.clearClipRange(two, 30, 70), clips([0, 30], [70, 100]))
})

test('inserir: dentro de um clipe ele cresce; num vão vira clipe novo', () => {
  const two = clips([0, 40], [60, 100])
  assert.deepEqual(C.insertClipRange(two, 20, 10), clips([0, 50], [70, 110]))
  assert.deepEqual(C.insertClipRange(two, 50, 5), clips([0, 40], [50, 55], [65, 105]))
  assert.deepEqual(C.insertClipRange(two, 40, 5), clips([0, 40], [40, 45], [65, 105]))
})

test('efeito que muda a duração e gravação por cima', () => {
  // Trecho [20, 40) do primeiro clipe vira 40 amostras: o clipe cresce e o outro anda.
  assert.deepEqual(C.replaceClipRange(clips([0, 40], [60, 100]), 20, 40, 40), clips([0, 60], [80, 120]))
  // Seleção que pega o vão: os dois clipes viram um.
  assert.deepEqual(C.replaceClipRange(clips([0, 40], [60, 100]), 30, 70, 40), clips([0, 100]))
  assert.deepEqual(C.addClip(clips([0, 40], [60, 100]), 30, 50), clips([0, 50], [60, 100]))
  assert.deepEqual(C.addClip(clips([0, 10]), 20, 30), clips([0, 10], [20, 30]))
})

test('aparar, deslocar, escalar e achar o clipe', () => {
  assert.deepEqual(C.trimClips(clips([0, 40], [60, 100]), 30, 80), clips([0, 10], [30, 50]))
  assert.deepEqual(C.shiftClips(clips([0, 10]), 5), clips([5, 15]))
  assert.deepEqual(C.scaleClips(clips([0, 100]), 0.5), clips([0, 50]))
  assert.equal(C.clipAt(clips([0, 40], [60, 100]), 50), -1)
  assert.equal(C.clipAt(clips([0, 40], [60, 100]), 60), 1)
})

test('projeto guarda os clipes; arquivo antigo abre como um clipe só', async () => {
  const track = {
    id: 1, kind: 'audio', name: 'a', color: '#fff', offset: 1, gain: 0, pan: 0, mute: false, solo: false, effects: [],
    channels: [new Float32Array(100)], clips: clips([0, 40], [60, 100]), sends: [], automation: { gain: [], pan: [] }
  }
  const project = { name: 'p', rate: 8000, tempo: 120, master: { gain: 0, effects: [] }, tracks: [track] }
  const back = await decodeProject(encodeProject(project))
  assert.deepEqual(back.tracks[0].clips, clips([0, 40], [60, 100]))
  const old = await decodeProject(encodeProject({ ...project, tracks: [{ ...track, clips: undefined }] }))
  assert.ok(!old.tracks[0].clips?.length) // o store trata como o buffer inteiro (makeTrack)
})
