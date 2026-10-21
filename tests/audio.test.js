// Testes dos algoritmos portados do Audacity. Rodar com: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channelVolumes, insertAt, mixdown, removeRange, replaceRange, resampleLinear } from '../src/audio/buffer.js'
import { EFFECTS, GENERATORS, findClipping, defaultsOf } from '../src/audio/effects.js'
import { averageSpectrum } from '../src/audio/dsp.js'
import { getSummary, rangeStats } from '../src/audio/summary.js'
import { decodeProject, encodeProject, encodeWav } from '../src/audio/fileio.js'

const fx = id => EFFECTS.find(e => e.id === id)
const gen = id => GENERATORS.find(e => e.id === id)
const f32 = a => Float32Array.from(a)
const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('remove/insere/substitui intervalos sem alterar o original', () => {
  const ch = f32([0, 1, 2, 3, 4])
  assert.deepEqual([...removeRange(ch, 1, 3)], [0, 3, 4])
  assert.deepEqual([...insertAt(ch, 2, f32([9, 9]))], [0, 1, 9, 9, 2, 3, 4])
  assert.deepEqual([...insertAt(f32([1]), 3, f32([5]))], [1, 0, 0, 5])
  assert.deepEqual([...replaceRange(ch, 1, 4, f32([7]))], [0, 7, 4])
  assert.deepEqual([...ch], [0, 1, 2, 3, 4])
})

test('lei de pan linear igual a WaveTrack::GetChannelVolume', () => {
  assert.deepEqual(channelVolumes({ gain: 0, pan: 0 }), [1, 1])
  assert.deepEqual(channelVolumes({ gain: 0, pan: -0.5 }), [1, 0.5])
  assert.deepEqual(channelVolumes({ gain: 0, pan: 0.25 }), [0.75, 1])
})

test('mixdown soma faixas respeitando offset', () => {
  const rate = 10
  const a = { gain: 0, pan: 0, offset: 0, channels: [f32([1, 1, 1, 1])] }
  const b = { gain: 0, pan: 0, offset: 0.2, channels: [f32([0.5, 0.5])] }
  const [l] = mixdown([a, b], rate, 0, 0.5, 1)
  assert.deepEqual([...l], [1, 1, 1.5, 1.5, 0])
})

test('Fade In/Out seguem a fórmula do Fade.cpp', () => {
  const ones = [new Float32Array(4).fill(1)]
  assert.deepEqual([...fx('fadein').process(ones)[0]], [0, 0.25, 0.5, 0.75])
  assert.deepEqual([...fx('fadeout').process(ones)[0]], [0.75, 0.5, 0.25, 0])
})

test('Normalize remove DC e leva o pico ao alvo', () => {
  const ch = f32([0.6, 0.4, 0.6, 0.4]) // DC = 0.5, extent = 0.1
  const [out] = fx('normalize').process([ch], { peak: 0, dc: true, independent: false })
  close(Math.max(...out.map(Math.abs)), 1)
  close(out.reduce((s, v) => s + v, 0), 0)
})

test('Amplify sugere o ganho que leva o pico a 0 dB e bloqueia clipping', () => {
  const ch = [f32([0.5, -0.25])]
  const p = fx('amplify').prepare(ch)
  close(p.amp, 6.02, 0.01)
  assert.throws(() => fx('amplify').process(ch, { amp: 12, clip: false }))
  assert.equal(fx('amplify').process(ch, { amp: 12, clip: true })[0].length, 2)
})

test('Eco usa buffer de histórico (EchoBase)', () => {
  const imp = f32([1, 0, 0, 0, 0])
  const [out] = fx('echo').process([imp], { delay: 2, decay: 0.5 }, { rate: 1 })
  assert.deepEqual([...out], [1, 0, 0.5, 0, 0.25])
})

test('Reverse, Invert, Repeat e Mudar velocidade', () => {
  const ch = f32([1, 2, 3])
  assert.deepEqual([...fx('reverse').process([ch])[0]], [3, 2, 1])
  assert.deepEqual([...fx('invert').process([ch])[0]], [-1, -2, -3])
  assert.equal(fx('repeat').process([ch], { count: 2 })[0].length, 9)
  assert.equal(fx('changeSpeed').process([new Float32Array(100)], { percent: 100 })[0].length, 50)
  assert.equal(resampleLinear(new Float32Array(100), 0.5).length, 200)
})

test('Filtro passa-baixa atenua alta frequência', () => {
  const rate = 44100
  const hi = gen('tone').generate({ wave: 'sine', freq: 10000, amp: 1 }, { rate, channels: 1, length: rate })[0]
  const [out] = fx('filter').process([hi], { type: 'lowpass', freq: 500, order: 2 }, { rate })
  const peakTail = Math.max(...out.slice(rate / 2).map(Math.abs))
  assert.ok(peakTail < 0.01, `pico ${peakTail}`)
})

test('Espectro encontra o pico de um tom de 1 kHz', () => {
  const rate = 8000
  const sig = gen('tone').generate({ wave: 'sine', freq: 1000, amp: 1 }, { rate, channels: 1, length: rate })[0]
  const { db } = averageSpectrum(sig, 1024)
  let best = 0
  for (let k = 1; k < db.length; k++) if (db[k] > db[best]) best = k
  close(best * rate / 1024, 1000, rate / 1024)
  close(db[best], 0, 0.5) // senoide em escala cheia ≈ 0 dB
})

test('Resumo min/max/rms em blocos de 256 confere com o cálculo direto', () => {
  const ch = new Float32Array(256 * 20).map((_, i) => Math.sin(i / 7))
  const s = getSummary(ch)
  assert.equal(s.s256.length, 20)
  const st = rangeStats(ch, 0, ch.length)
  close(st.max, Math.max(...ch))
  close(st.min, Math.min(...ch))
})

test('Find Clipping detecta sequências saturadas', () => {
  const ch = f32([0, 1, 1, 1, 0, -1, -1, 0])
  const hits = findClipping([ch], 1, 3)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].samples, 3)
})

test('Geradores produzem o comprimento pedido', () => {
  for (const g of GENERATORS) {
    const out = g.generate(defaultsOf(g), { rate: 8000, channels: 2, length: 800 })
    assert.equal(out.length, 2)
    assert.equal(out[0].length, 800)
  }
})

test('WAV 16-bit tem cabeçalho RIFF correto', async () => {
  const blob = encodeWav([f32([0, 0.5]), f32([0, -0.5])], 44100)
  const buf = new DataView(await blob.arrayBuffer())
  assert.equal(blob.size, 44 + 2 * 2 * 2)
  assert.equal(buf.getUint16(22, true), 2)
  assert.equal(buf.getUint32(24, true), 44100)
})

test('Projeto .ravenproj sobrevive a salvar e abrir', async () => {
  const project = {
    name: 'Teste ç', rate: 22050,
    tracks: [
      { name: 'A', offset: 1.5, gain: -3, pan: 0.2, mute: false, solo: true, channels: [f32([0.1, 0.2, 0.3])] },
      { name: 'B', offset: 0, gain: 0, pan: 0, mute: true, solo: false, channels: [f32([1, -1]), f32([0.5, -0.5])] }
    ]
  }
  const back = await decodeProject(encodeProject(project))
  assert.equal(back.name, 'Teste ç')
  assert.equal(back.rate, 22050)
  assert.equal(back.tracks[0].offset, 1.5)
  assert.equal(back.tracks[0].solo, true)
  assert.deepEqual([...back.tracks[1].channels[1]], [0.5, -0.5])
  close(back.tracks[0].channels[0][2], 0.3)
})
