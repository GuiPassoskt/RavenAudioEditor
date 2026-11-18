// Teste da Fase 4 (etapa B) no motor, sem interface: entrada MIDI (simulada com
// midi.simulate, que injeta no mesmo ponto em que chegariam as mensagens do
// dispositivo), roteamento para a faixa alvo e gravação com o tempo certo.
// Toca notas baixas por ~4 s.
//
//   RAVEN_PLUGIN_CACHE=<xml> node engine-midi.mjs <raven-engine.exe> <pasta-temporária>

import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'

const [exe, dir] = process.argv.slice(2)
const env = { ...process.env, RAVEN_AUDIO_SETTINGS: path.join(dir, 'audio-settings.xml') }
const child = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
const events = []
let id = 0
readline.createInterface({ input: child.stdout }).on('line', line => {
  let m
  try { m = JSON.parse(line) } catch { return }
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
const meters = (from, to = Date.now()) => events.filter(e => e.event === 'meters' && e.at >= from && e.at <= to)
const peakSince = (from, to) => Math.max(0, ...meters(from, to).map(e => Math.max(...e.master)))
const noteOn = (pitch, vel = 100) => req('midi.simulate', { status: 0x90, data1: pitch, data2: vel })
const noteOff = pitch => req('midi.simulate', { status: 0x80, data1: pitch, data2: 0 })

const rate = 44100
const master = { gain: 0, effects: [] }
const midiTrack = (id, instrument = null) => ({
  id, kind: 'midi', offset: 0, gain: -12, pan: 0, mute: false, solo: false, effects: [],
  program: 0, drum: false, notes: [], notesKey: '1', instrument
})
const sync = (tracks, midiTarget) => req('project.sync', { rate, tracks, master, midiTarget })

try {
  const devices = await req('midi.devices')
  console.log('entradas MIDI nesta máquina:', devices.inputs.map(d => d.name).join(', ') || 'nenhuma')

  // 1. Faixa alvo com o sintetizador embutido: toca e acende a atividade MIDI.
  await sync([midiTrack('a'), midiTrack('b')], 'a')
  await sleep(300)
  let t = Date.now()
  await noteOn(60)
  await sleep(400)
  await noteOff(60)
  await sleep(100)
  check(peakSince(t) > 0.005 && meters(t).some(e => e.midiIn), 'entrada MIDI toca na faixa alvo (sintetizador)', `pico ${peakSince(t).toFixed(3)}`)
  await sleep(900)
  check(peakSince(Date.now() - 300) < 0.0005, 'note off solta a nota')

  // 2. Sem faixa alvo: nada toca.
  await sync([midiTrack('a'), midiTrack('b')], null)
  await sleep(300)
  t = Date.now()
  await noteOn(64); await sleep(300); await noteOff(64); await sleep(200)
  check(peakSince(t) < 0.0005, 'sem faixa MIDI selecionada, a entrada não toca')

  // 3. Faixa alvo com instrumento virtual.
  const list = await req('plugins.list')
  const inst = list.find(p => p.name === 'Black Pearl Drumkit') ?? list.find(p => p.isInstrument)
  if (inst) {
    await sync([midiTrack('d', { uid: 'i1', type: 'plugin', pluginId: inst.id, enabled: true, stateVersion: 1, state: '' })], 'd')
    await sleep(3000) // o kit carrega as amostras em segundo plano depois de criado
    t = Date.now()
    await noteOn(38, 110); await sleep(300); await noteOff(38); await sleep(200)
    check(peakSince(t) > 0.005, `entrada MIDI toca no instrumento "${inst.name}"`, `pico ${peakSince(t).toFixed(3)}`)
  }

  // 4. Gravação: notas em 0,5 s (0,3 s de duração) e 1,2 s (0,2 s) depois do play.
  await sync([midiTrack('a')], 'a')
  const status = await req('audio.status')
  await req('midi.startRecording')
  await req('transport.play', { t0: 0, t1: 3 })
  const start = Date.now()
  const at = ms => sleep(Math.max(0, start + ms - Date.now()))
  await at(500); await noteOn(60)
  await at(800); await noteOff(60)
  await at(1200); await noteOn(67)
  await at(1400); await noteOff(67)
  await at(1700)
  const recorded = await req('midi.stopRecording')
  await req('transport.stop')
  console.log('eventos:', recorded.map(e => `${(e.status & 0xF0) === 0x90 && e.data2 ? 'on' : 'off'} ${e.data1} @ ${e.t.toFixed(3)}`).join(' | '))
  const ons = recorded.filter(e => (e.status & 0xF0) === 0x90 && e.data2 > 0)
  const offs = recorded.filter(e => (e.status & 0xF0) === 0x80 || ((e.status & 0xF0) === 0x90 && e.data2 === 0))
  const latency = status.latencyMs / 1000
  const first = ons.find(e => e.data1 === 60)
  const second = ons.find(e => e.data1 === 67)
  const dur = offs.find(e => e.data1 === 60)?.t - first?.t
  console.log(`gravado: ${recorded.length} eventos; dó em ${first?.t.toFixed(3)} s, sol em ${second?.t.toFixed(3)} s; latência de saída ${(latency * 1000).toFixed(0)} ms`)
  check(ons.length === 2 && offs.length === 2, 'gravação capta note on e note off')
  // Tempo esperado: momento do envio menos a latência de saída (tolerância de 120 ms
  // pelo agendamento do Node e do IPC, que não existem com um teclado de verdade).
  check(Math.abs(first.t - (0.5 - latency)) < 0.12 && Math.abs(second.t - (1.2 - latency)) < 0.12,
    'tempo das notas gravadas (latência de saída descontada)')
  check(Math.abs(dur - 0.3) < 0.06 && Math.abs(second.t - first.t - 0.7) < 0.06, 'duração e intervalo entre as notas',
    `duração ${dur.toFixed(3)} s, intervalo ${(second.t - first.t).toFixed(3)} s`)
} catch (e) {
  failures++
  console.log('FALHA', e.message)
}

child.stdin.end()
console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo.')
process.exitCode = failures ? 1 : 0
