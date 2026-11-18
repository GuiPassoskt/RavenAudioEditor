// Teste da Fase 5 no motor, sem interface: barramentos e envios (pós-fader, solo
// seguro, compensação de latência através do barramento), automação de volume e
// pan, e render em segundo plano (progresso, motor livre durante o render, cancelar).
//
//   node engine-mix.mjs <raven-engine.exe> <pasta-temporária>
//
// Com RAVEN_PLUGIN_CACHE apontando para a lista de plugins e "MFreeformPhase"
// (MeldaProduction, latência de 8192 amostras) instalado, testa também o PDC no barramento.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const rms = (ch, a = 0, b = ch.length) => {
  let s = 0
  for (let i = a; i < b; i++) s += ch[i] * ch[i]
  return Math.sqrt(s / Math.max(1, b - a))
}
const db = (a, b) => 20 * Math.log10(a / b)

const rate = 44100
const frames = rate * 2
let seed = 1
const noise = new Float32Array(frames).map(() => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 * 2 - 1) * 0.3 })
writeFileSync(path.join(dir, 'noise.f32'), Buffer.from(noise.buffer))
const dry = rms(noise)

const track = (id, extra = {}) => ({ id, kind: 'audio', clip: 'ruido', offset: 0, gain: 0, pan: 0, mute: false, solo: false, effects: [], sends: [], automation: null, ...extra })
const bus = (id, extra = {}) => ({ id, kind: 'bus', offset: 0, gain: 0, pan: 0, mute: false, solo: false, effects: [], ...extra })
const master = { gain: 0, effects: [] }
const render = async (tracks, { t1 = 2, job } = {}) => {
  const output = path.join(dir, `out-${job ?? 'x'}.f32`)
  const r = await req('render.offline', { project: { rate, tracks, master }, t0: 0, t1, applyMaster: true, output, job })
  const data = readFileSync(output)
  const all = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + r.frames * 8))
  return [all.subarray(0, r.frames), all.subarray(r.frames)]
}

try {
  await req('clips.load', { clipId: 'ruido', channels: 1, frames, file: path.join(dir, 'noise.f32') })

  // 1. Envio pós-fader de -6 dB: saída = faixa + metade dela.
  const send = [{ bus: 'b', level: -6.0206 }]
  let [l] = await render([track('1', { sends: send }), bus('b')])
  check(Math.abs(rms(l) / dry - 1.5) < 0.01, 'envio para barramento soma na saída', `${(rms(l) / dry).toFixed(3)}× (esperado 1,5×)`)

  // 2. Pós-fader: faixa muda não envia; barramento mudo não toca.
  ;[l] = await render([track('1', { sends: send, mute: true }), bus('b')])
  check(rms(l) < 1e-6, 'faixa muda não manda nada para o barramento')
  ;[l] = await render([track('1', { sends: send }), bus('b', { mute: true })])
  check(Math.abs(rms(l) / dry - 1) < 0.01, 'barramento mudo cala só o envio')

  // 3. Solo seguro: solar a faixa não cala o barramento; a outra faixa cala.
  ;[l] = await render([track('1', { sends: send, solo: true }), track('2', { gain: -20 }), bus('b')])
  check(Math.abs(rms(l) / dry - 1.5) < 0.01, 'barramento continua tocando com uma faixa em solo', `${(rms(l) / dry).toFixed(3)}×`)

  // 4. O volume do barramento vale para tudo o que chega nele: duas faixas
  // enviando 0 dB para um barramento em -6 dB = 2× direto + 1× pelo barramento.
  const full = [{ bus: 'b', level: 0 }]
  ;[l] = await render([track('1', { sends: full }), track('2', { sends: full }), bus('b', { gain: -6.0206 })])
  check(Math.abs(rms(l) / dry - 3) < 0.02, 'duas faixas no mesmo barramento com o volume dele', `${(rms(l) / dry).toFixed(3)}× (esperado 3×)`)

  // 5. PDC: plugin com latência no barramento; a saída direta espera por ele.
  const phase = (await req('plugins.list').catch(() => [])).find(p => p.name === 'MFreeformPhase')
  if (phase) {
    const slot = { uid: 'ph', type: 'plugin', pluginId: phase.id, enabled: true, stateVersion: 1, state: '' }
    ;[l] = await render([track('1', { sends: send }), bus('b', { effects: [slot] })])
    check(Math.abs(rms(l, 10000) / rms(noise, 10000) - 1.5) < 0.03, 'barramento com latência continua alinhado com a saída direta', `${(rms(l, 10000) / rms(noise, 10000)).toFixed(3)}×`)
  } else {
    console.log('--   PDC no barramento: MFreeformPhase não está na lista de plugins, pulando')
  }

  // 6. Automação de volume: rampa de 0 a -40 dB entre 0,5 e 1,5 s (somada ao fader de -6 dB).
  const ramp = { gain: [{ t: 0.5, v: 0 }, { t: 1.5, v: -40 }], pan: [] }
  ;[l] = await render([track('1', { gain: -6, automation: ramp })])
  const at = s => db(rms(l, Math.round((s - 0.01) * rate), Math.round((s + 0.01) * rate)), rms(noise, Math.round((s - 0.01) * rate), Math.round((s + 0.01) * rate)))
  check(Math.abs(at(0.25) + 6) < 0.3 && Math.abs(at(1.0) + 26) < 1 && Math.abs(at(1.75) + 46) < 1,
    'automação de volume segue o envelope', `${at(0.25).toFixed(1)} / ${at(1.0).toFixed(1)} / ${at(1.75).toFixed(1)} dB (esperado -6 / -26 / -46)`)

  // 7. Automação de pan: tudo à esquerda.
  let r
  ;[l, r] = await render([track('1', { automation: { gain: [], pan: [{ t: 0, v: -1 }] } })])
  check(rms(r) < 1e-6 && Math.abs(rms(l) / dry - 1) < 0.01, 'automação de pan leva o som para a esquerda')

  // 8. Render em segundo plano: 1 min com reverb longo. O motor responde enquanto isso.
  const heavy = [track('1', { effects: [1, 2].map(i => ({ uid: `r${i}`, type: 'reverb', enabled: true, params: { time: 10, damping: 0.5, wet: -6, dry: 0 } })) })]
  events.length = 0
  const t0 = Date.now()
  const long = render(heavy, { t1: 60, job: 'longo' })
  await new Promise(res => setTimeout(res, 300))
  const p0 = Date.now()
  await req('ping')
  const pingMs = Date.now() - p0
  await long
  const renderMs = Date.now() - t0
  const progress = events.filter(e => e.event === 'render.progress' && e.job === 'longo').map(e => e.progress)
  check(pingMs < 150 && renderMs > pingMs * 3, 'motor responde durante o render', `ping em ${pingMs} ms com o render levando ${renderMs} ms`)
  check(progress.length >= 2 && progress.at(-1) === 1 && progress.every((p, i) => !i || p >= progress[i - 1]),
    'eventos de progresso do render', `${progress.length} eventos: ${progress.slice(0, 4).map(p => p.toFixed(2)).join(', ')}…`)

  // 9. Cancelar.
  const cancelled = render(heavy, { t1: 60, job: 'cancelar' }).then(() => 'terminou', e => e.message)
  await new Promise(res => setTimeout(res, 300))
  const c0 = Date.now()
  await req('render.cancel', { job: 'cancelar' })
  const outcome = await cancelled
  check(outcome === 'Render cancelado.' && Date.now() - c0 < 1000, 'render cancelado', `${outcome} em ${Date.now() - c0} ms`)
} catch (e) {
  failures++
  console.log('FALHA', e.message)
} finally {
  await req('quit').catch(() => {})
}

console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo.')
process.exit(failures ? 1 : 0)
