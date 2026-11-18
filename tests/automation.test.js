// Testes da Fase 5: automação (envelopes), envios para barramentos no arquivo de projeto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  automationRamps, automationValues, envelopeAt, hasAutomation, insertAutomationGap,
  removeAutomationRange, trimAutomation
} from '../src/audio/automation.js'
import { decodeProject, encodeProject } from '../src/audio/fileio.js'

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const lane = (...pairs) => pairs.map(([t, v]) => ({ t, v }))

test('envelope interpola em linha reta e segura as pontas', () => {
  const points = lane([1, 0], [3, -12])
  close(envelopeAt(points, 0), 0)
  close(envelopeAt(points, 2), -6)
  close(envelopeAt(points, 10), -12)
})

test('valores efetivos: volume soma ao fader, pan substitui, tempo relativo à faixa', () => {
  const track = { offset: 10, gain: -3, pan: 0.5, automation: { gain: lane([0, 0], [2, -6]), pan: lane([0, -1]) } }
  const v = automationValues(track, 11) // 1 s depois do início da faixa
  close(v.gain, -6)
  close(v.pan, -1)
  const plain = automationValues({ ...track, automation: { gain: [], pan: [] } }, 11)
  assert.deepEqual(plain, { gain: -3, pan: 0.5 })
  assert.ok(hasAutomation(track))
  assert.ok(!hasAutomation({ automation: { gain: [], pan: [] } }))
})

test('rampas: amostradas onde o volume muda, retas onde é constante', () => {
  const track = { offset: 0, gain: 0, pan: 0, automation: { gain: lane([1, 0], [2, -20]), pan: [] } }
  const ramps = automationRamps(track, 0, 3)
  assert.equal(ramps[0].T, 0)
  assert.equal(ramps.at(-1).T, 3)
  // De 0 a 1 s e de 2 a 3 s o volume não muda: sem pontos intermediários.
  assert.ok(!ramps.some(p => p.T > 0 && p.T < 1))
  assert.ok(!ramps.some(p => p.T > 2 && p.T < 3))
  assert.ok(ramps.filter(p => p.T > 1 && p.T < 2).length > 40)
  close(ramps.at(-1).l, 0.1, 1e-4) // -20 dB
})

test('edição mantém os pontos alinhados com o áudio', () => {
  const a = { gain: lane([1, 0], [3, -6], [5, -12]), pan: [] }
  assert.deepEqual(removeAutomationRange(a, 2, 4).gain, lane([1, 0], [3, -12]))
  assert.deepEqual(insertAutomationGap(a, 2, 1).gain, lane([1, 0], [4, -6], [6, -12]))
  assert.deepEqual(trimAutomation(a, 1, 3).gain, lane([0, 0], [2, -6]))
})

test('projeto salva barramentos e envios pela posição do barramento', async () => {
  const project = {
    name: 'p', rate: 8000, tempo: 120,
    master: { gain: 0, effects: [] },
    tracks: [
      { id: 7, kind: 'audio', name: 'voz', color: '#fff', offset: 0, gain: 0, pan: 0, mute: false, solo: false, effects: [],
        channels: [new Float32Array([0.5, -0.5])], sends: [{ bus: 9, level: -6 }], automation: { gain: lane([0, -3]), pan: [] } },
      { id: 9, kind: 'bus', name: 'reverb', color: '#000', offset: 0, gain: -2, pan: 0, mute: false, solo: false, effects: [],
        channels: [], sends: [], automation: { gain: [], pan: [] } }
    ]
  }
  const back = await decodeProject(encodeProject(project))
  assert.deepEqual(back.tracks[0].sends, [{ bus: 1, level: -6 }])
  assert.deepEqual(back.tracks[0].automation.gain, lane([0, -3]))
  assert.equal(back.tracks[1].kind, 'bus')
  assert.deepEqual(back.tracks[1].channels, [])
  assert.deepEqual([...back.tracks[0].channels[0]], [0.5, -0.5])
})
