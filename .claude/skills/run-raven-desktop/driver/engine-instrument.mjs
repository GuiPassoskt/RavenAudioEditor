// Teste da Fase 4 (etapa A) no motor, sem interface: instrumento virtual numa
// faixa MIDI (render offline, reprodução ao vivo, nota avulsa pela faixa, release
// ao parar) e notas ao vivo no sintetizador embutido. Toca sons baixos por ~3 s.
//
//   RAVEN_PLUGIN_CACHE=<xml> node engine-instrument.mjs <raven-engine.exe> <pasta-temporária>
//
// Precisa de um instrumento da lista; usa "Black Pearl Drumkit" (LV2, AVL Drumkits)
// ou o primeiro instrumento encontrado.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [exe, dir] = process.argv.slice(2)
const env = { ...process.env, RAVEN_AUDIO_SETTINGS: path.join(dir, 'audio-settings.xml') }
const child = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
const events = []
let id = 0
readline.createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line)
  if (m.event) return events.push({ ...m, at: Date.now() })
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.res(m.result) : p.rej(new Error(m.error))
})
const req = (cmd, args = {}) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, { res, rej })
  child.stdin.write(JSON.stringify({ ...args, id: i, cmd }) + '\n')
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const peak = ch => ch.reduce((m, x) => (Number.isFinite(x) ? Math.max(m, Math.abs(x)) : Infinity), 0)
const meterPeak = (from, to = Date.now()) => Math.max(0, ...events.filter(e => e.event === 'meters' && e.at >= from && e.at <= to).map(e => Math.max(...e.master)))

const rate = 44100
const master = { gain: 0, effects: [] }
const note = (pitch, start, dur = 0.2) => ({ start, dur, pitch, vel: 110 })
const midiTrack = (instrument, notes, gain = -12) => ({
  id: 'm', kind: 'midi', offset: 0, gain, pan: 0, mute: false, solo: false, effects: [],
  program: 0, drum: false, notes, notesKey: String(Math.random()), instrument
})

try {
  const list = await req('plugins.list')
  const inst = list.find(p => p.name === 'Black Pearl Drumkit') ?? list.find(p => p.isInstrument)
  if (!inst) throw new Error('nenhum instrumento na lista de plugins')
  const slot = { uid: 'i1', type: 'plugin', pluginId: inst.id, enabled: true, stateVersion: 1, state: '' }
  const notes = [note(36, 0.05), note(38, 0.3), note(42, 0.55), note(36, 0.8)]

  // 1. Render offline com o instrumento.
  const output = path.join(dir, 'inst.f32')
  const r = await req('render.offline', { project: { rate, tracks: [midiTrack(slot, notes, 0)], master }, t0: 0, t1: 1.5, applyMaster: true, output })
  const data = readFileSync(output)
  const left = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + r.frames * 4))
  const p = peak(left)
  check(Number.isFinite(p) && p > 0.01, `render offline com o instrumento "${inst.name}"`, `pico ${p.toFixed(3)}`)
  const silentBefore = peak(left.subarray(0, Math.floor(0.04 * rate)))
  check(silentBefore < 0.001, 'silêncio antes da primeira nota', `pico ${silentBefore.toFixed(4)}`)

  // 2. Reprodução ao vivo com o instrumento.
  await req('project.sync', { rate, tracks: [midiTrack(slot, notes)], master })
  const info = await req('project.pluginInfo', { uid: 'i1' })
  check(info.name === inst.name, 'instrumento carregado na faixa', `${info.params.length} parâmetros`)
  let t = Date.now()
  await req('transport.play', { t0: 0, t1: 1.2 })
  await sleep(1500)
  check(meterPeak(t) > 0.005, 'reprodução ao vivo com o instrumento', `pico ${meterPeak(t).toFixed(3)}`)

  // 3. Parado: nota avulsa pela faixa (instrumento).
  await sleep(1500)
  t = Date.now()
  await req('synth.audition', { trackId: 'm', pitch: 38, vel: 110 })
  await sleep(500)
  check(meterPeak(t) > 0.005, 'nota avulsa toca pelo instrumento da faixa', `pico ${meterPeak(t).toFixed(3)}`)

  // 4. Sintetizador embutido: nota avulsa e release ao parar.
  await req('project.sync', { rate, tracks: [midiTrack(null, [note(60, 0, 2)])], master })
  await sleep(1000)
  t = Date.now()
  await req('synth.audition', { trackId: 'm', pitch: 64, vel: 100 })
  await sleep(400)
  check(meterPeak(t) > 0.005, 'nota avulsa pelo sintetizador da faixa', `pico ${meterPeak(t).toFixed(3)}`)

  await sleep(1500)
  await req('transport.play', { t0: 0, t1: 2 })
  await sleep(400)
  await req('transport.stop')
  const stopAt = Date.now()
  await sleep(1200)
  const tail = meterPeak(stopAt + 30, stopAt + 150)
  const after = meterPeak(stopAt + 900)
  check(tail > 0.001 && after < 0.001, 'ao parar, a nota solta com release (sem corte seco nem nota presa)',
    `${tail.toFixed(4)} logo depois, ${after.toFixed(4)} após 0,9 s`)
} catch (e) {
  failures++
  console.log('FALHA', e.message)
}

child.stdin.end()
console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo.')
process.exitCode = failures ? 1 : 0
