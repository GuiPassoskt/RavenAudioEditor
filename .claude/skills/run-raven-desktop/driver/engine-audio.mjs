// Teste do motor de áudio nativo sem interface (Fase 2): status, dispositivos,
// render offline (ganho/pan exatos, os 8 efeitos, MIDI), reprodução ao vivo e gravação.
//
//   node engine-audio.mjs <raven-engine.exe> <pasta-temporária> [--live]
//
// Com --live toca um tom baixo (−30 dB) por 1 s e grava 1 s da entrada padrão.
// Sai com código 1 se alguma verificação falhar.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [exe, dir, ...flags] = process.argv.slice(2)
const live = flags.includes('--live')
const env = { ...process.env, RAVEN_AUDIO_SETTINGS: path.join(dir, 'audio-settings.xml') }
const child = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
const events = []
let id = 0
readline.createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line)
  if (m.event) return events.push(m)
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
const stats = ch => {
  let peak = 0; let sq = 0; let nan = false
  for (const x of ch) { if (!Number.isFinite(x)) nan = true; peak = Math.max(peak, Math.abs(x)); sq += x * x }
  return { peak: +peak.toFixed(4), rms: +Math.sqrt(sq / ch.length).toFixed(4), nan }
}
const readPlanar = (file, channels, frames) => {
  const data = readFileSync(file)
  return Array.from({ length: channels }, (_, c) => new Float32Array(data.buffer.slice(data.byteOffset + c * frames * 4, data.byteOffset + (c + 1) * frames * 4)))
}

const rate = 44100
const tone = new Float32Array(rate).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / rate))
const toneFile = path.join(dir, 'tone.f32')
writeFileSync(toneFile, Buffer.from(tone.buffer))
const track = (extra = {}) => ({ id: '1', kind: 'audio', clip: 'tom', offset: 0, gain: 0, pan: 0, mute: false, solo: false, effects: [], ...extra })
const render = async (tracks, { master = { gain: 0, effects: [] }, t1 = 1, applyMaster = true } = {}) => {
  const output = path.join(dir, 'out.f32')
  const r = await req('render.offline', { project: { rate, tracks, master }, t0: 0, t1, applyMaster, output })
  return readPlanar(output, 2, r.frames)
}

try {
  const info = await req('ping')
  console.log('motor:', info.name, info.version, info.juce)
  console.log('áudio:', JSON.stringify(info.audio))
  check(!info.audio.error, 'dispositivo de áudio aberto', `${info.audio.type} · ${info.audio.device} · ${info.audio.sampleRate} Hz · buffer ${info.audio.bufferSize}`)

  const devices = await req('audio.devices')
  console.log('tipos de driver:', devices.types.map(t => `${t.name} (${t.outputs.length} saídas, ${t.inputs.length} entradas)`).join('; '))
  check(devices.types.some(t => t.name.includes('ASIO')), 'ASIO disponível na lista de drivers')

  await req('clips.load', { clipId: 'tom', channels: 1, frames: rate, file: toneFile })

  // Ganho −6 dB e pan 0,5 à direita: L = 0,5 · 0,501 · 0,5; R = 0,5 · 0,501.
  const [l, r] = await render([track({ gain: -6, pan: 0.5 })])
  const sl = stats(l); const sr = stats(r)
  check(Math.abs(sl.peak - 0.1253) < 0.002 && Math.abs(sr.peak - 0.2506) < 0.002, 'ganho e pan (lei linear do Audacity)', `L ${sl.peak} R ${sr.peak}`)
  const [ml] = await render([track({ mute: true })])
  check(stats(ml).peak === 0, 'mudo')
  const [solo] = await render([track(), track({ id: '2', solo: true, gain: -20 })])
  check(Math.abs(stats(solo).peak - 0.05) < 0.002, 'solo isola a faixa', `pico ${stats(solo).peak}`)
  const [fader] = await render([track()], { master: { gain: -6, effects: [] } })
  check(Math.abs(stats(fader).peak - 0.2506) < 0.002, 'fader do master', `pico ${stats(fader).peak}`)

  const fx = (type, params) => ({ uid: type, type, enabled: true, params })
  // s: em regime (segunda metade); all: trecho inteiro (pega estouros no ataque).
  // Compressor e Limitador têm o ganho de compensação automático do Chromium: o
  // Limitador a −12 dB sai em torno de −5 dB, igual ao motor do navegador.
  const effects = [
    ['gain', { gain: -12 }, s => Math.abs(s.peak - 0.1256) < 0.003],
    ['bassTreble', { bass: 0, treble: 0, gain: 6 }, s => Math.abs(s.peak - 0.9976) < 0.01],
    ['filter', { type: 'lowpass', freq: 200, order: 4 }, s => s.rms < 0.003],
    ['filter', { type: 'highpass', freq: 200, order: 2 }, s => s.peak > 0.45],
    ['echo', { delay: 0.25, decay: 0.5 }, s => s.peak > 0.7],
    ['reverb', { time: 1, damping: 0.5, wet: -6, dry: 0 }, s => s.rms > 0.36],
    ['compressor', { threshold: -30, ratio: 8, knee: 6, attack: 1, release: 100, makeup: 0 }, (s, all) => s.peak < 0.35 && all.peak < 0.6],
    ['limiter', { ceiling: -12, gain: 0 }, (s, all) => s.peak > 0.45 && s.peak < 0.7 && all.peak < 0.8],
    ['distortion', { drive: 24, output: -6 }, s => s.peak > 0.4 && s.rms > 0.3]
  ]
  for (const [type, params, ok] of effects) {
    const [out] = await render([track({ effects: [fx(type, params)] })])
    const all = stats(out)
    const s = stats(out.subarray(rate / 2))
    check(!all.nan && ok(s, all), `efeito ${type}`, JSON.stringify(params) + ` -> pico ${s.peak} rms ${s.rms} (pico no trecho todo ${all.peak})`)
  }
  const [bypass] = await render([track({ effects: [{ ...fx('gain', { gain: -40 }), enabled: false }] })])
  check(Math.abs(stats(bypass).peak - 0.5) < 0.002, 'efeito desligado deixa o som passar')

  // MIDI: piano (dó central), órgão e bateria.
  const midi = (program, drum, notes) => ({ id: 'm', kind: 'midi', offset: 0, gain: 0, pan: 0, mute: false, solo: false, effects: [], program, drum, notes, notesKey: '1' })
  const note = (pitch, start = 0.1, dur = 0.5) => ({ start, dur, pitch, vel: 100 })
  for (const [label, t] of [['piano', midi(0, false, [note(60), note(64), note(67)])], ['órgão', midi(16, false, [note(48)])],
    ['synth pad (filtro)', midi(88, false, [note(60)])], ['bateria', midi(0, true, [note(36), note(38, 0.3), note(42, 0.5), note(49, 0.6), note(45, 0.7)])]]) {
    const [out] = await render([t])
    const s = stats(out)
    check(!s.nan && s.peak > 0.02 && s.peak < 1.5, `MIDI ${label}`, `pico ${s.peak} rms ${s.rms}`)
  }

  if (live) {
    await req('project.sync', { rate, tracks: [track({ gain: -24 })], master: { gain: 0, effects: [] } })
    events.length = 0
    await req('transport.play', { t0: 0, t1: 1 })
    await sleep(1600)
    const meters = events.filter(e => e.event === 'meters')
    const maxMaster = Math.max(...meters.map(m => Math.max(...m.master)))
    check(meters.length > 10 && maxMaster > 0.02, 'reprodução ao vivo com medidores', `${meters.length} eventos, pico ${maxMaster.toFixed(3)}`)
    check(events.some(e => e.event === 'transport.ended'), 'fim do trecho avisado')
    const positions = meters.filter(m => m.playing).map(m => m.position)
    check(positions.length > 5 && positions.every((p, i) => i === 0 || p >= positions[i - 1]), 'posição avança', `${positions[0]?.toFixed(3)} … ${positions.at(-1)?.toFixed(3)} s`)

    try {
      const cap = await req('capture.start', { channels: 2 })
      await sleep(1000)
      const output = path.join(dir, 'cap.f32')
      let frames = 0
      for (let i = 0; i < 3; i++) {
        frames += (await req('capture.read', { output })).frames
        await sleep(100)
      }
      await req('capture.stop')
      check(frames > rate * 0.9 && frames < rate * 1.6, 'gravação na taxa do projeto', `${frames} amostras em ~1,2 s (dispositivo a ${cap.deviceRate} Hz)`)
    } catch (e) {
      check(false, 'gravação', e.message)
    }
  }
} catch (e) {
  failures++
  console.log('FALHA', e.message)
}

child.stdin.end()
console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo.')
process.exitCode = failures ? 1 : 0
