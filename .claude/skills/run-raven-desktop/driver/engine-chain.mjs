// Teste da Fase 3 no motor, sem interface: plugin VST3 numa cadeia em tempo real,
// estado (aviso, desfazer, refazer, sem eco), render offline com o estado ao vivo,
// compensação de latência (PDC), janela nativa e plugin ausente.
//
//   RAVEN_PLUGIN_CACHE=<xml> node engine-chain.mjs <raven-engine.exe> <pasta-temporária>
//
// Precisa de "kHs Gain" (Kilohearts Essentials) e "MFreeformPhase" (MeldaProduction
// Free Bundle, latência de 8192 amostras e fase plana por padrão).

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
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const rms = ch => Math.sqrt(ch.reduce((s, x) => s + x * x, 0) / ch.length)
const db = (a, b) => 20 * Math.log10(a / b)

const rate = 44100
const frames = rate * 2
let seed = 1
const noise = new Float32Array(frames).map(() => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 * 2 - 1) * 0.3 })
writeFileSync(path.join(dir, 'noise.f32'), Buffer.from(noise.buffer))

const track = (id, effects) => ({ id, kind: 'audio', clip: 'ruido', offset: 0, gain: 0, pan: 0, mute: false, solo: false, effects })
const master = { gain: 0, effects: [] }
const render = async tracks => {
  const output = path.join(dir, 'out.f32')
  const r = await req('render.offline', { project: { rate, tracks, master }, t0: 0, t1: 2, applyMaster: true, output })
  const data = readFileSync(output)
  return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + r.frames * 4))
}
const sync = tracks => req('project.sync', { rate, tracks, master })

try {
  await req('clips.load', { clipId: 'ruido', channels: 1, frames, file: path.join(dir, 'noise.f32') })
  const list = await req('plugins.list')
  const gain = list.find(p => p.name === 'kHs Gain')
  const phase = list.find(p => p.name === 'MFreeformPhase')
  const dry = rms(noise)

  // 1. Plugin na cadeia, estado de fábrica.
  const slot = (version, state) => ({ uid: 'p1', type: 'plugin', pluginId: gain.id, enabled: true, stateVersion: version, ...(state !== undefined ? { state } : {}) })
  await sync([track('1', [slot(1, '')])])
  const info = await req('project.pluginInfo', { uid: 'p1' })
  const gainParam = info.params.find(p => p.name === 'Gain')
  check(info.name === 'kHs Gain' && gainParam, 'plugin carregado na cadeia', `${info.params.length} parâmetros, latência ${info.latency}`)

  // 2. Mexer no parâmetro avisa o estado novo (depois de 400 ms) e o render usa a instância ao vivo.
  events.length = 0
  await req('project.setPluginParam', { uid: 'p1', index: gainParam.index, value: 0.2 })
  await sleep(900)
  const stateEvents = events.filter(e => e.event === 'chain.pluginState')
  check(stateEvents.length === 1 && events.some(e => e.event === 'chain.paramChanged'), 'aviso de estado e de parâmetro', `${stateEvents.length} aviso(s) de estado`)
  const tweaked = stateEvents[0]?.state
  const out18 = await render([track('1', [slot(1)])])
  check(Math.abs(db(rms(out18), dry) + 18) < 0.3, 'render offline com o estado ao vivo (−18 dB)', `${db(rms(out18), dry).toFixed(2)} dB`)

  // 3. Desfazer (estado vazio = de fábrica) e refazer (estado guardado), sem eco.
  events.length = 0
  await sync([track('1', [slot(2, '')])])
  const undone = (await req('project.pluginInfo', { uid: 'p1' })).params.find(p => p.name === 'Gain')
  await sync([track('1', [slot(3, tweaked)])])
  const redone = (await req('project.pluginInfo', { uid: 'p1' })).params.find(p => p.name === 'Gain')
  await sleep(900)
  check(undone.text.includes('0.00') && redone.text.includes('18'), 'desfazer e refazer o estado do plugin', `${undone.text} -> ${redone.text}`)
  check(!events.some(e => e.event === 'chain.pluginState'), 'aplicar estado não gera um ajuste novo (sem eco)')

  // 4. Desligado (bypass) passa o som.
  const off = await render([track('1', [{ ...slot(3), enabled: false }])])
  check(Math.abs(db(rms(off), dry)) < 0.1, 'plugin desligado passa o som', `${db(rms(off), dry).toFixed(2)} dB`)

  // 5. Compensação de latência: mesma fonte em duas faixas, uma com 8192 amostras de atraso.
  if (phase) {
    const latent = { uid: 'p2', type: 'plugin', pluginId: phase.id, enabled: true, stateVersion: 1, state: '' }
    const sum = await render([track('a', [latent]), track('b', [])])
    check(Math.abs(db(rms(sum), dry) - 6.02) < 0.3, 'PDC: faixas alinhadas somam +6 dB', `${db(rms(sum), dry).toFixed(2)} dB (desalinhadas dariam ~+3 dB)`)
    await sync([track('a', [latent]), track('b', [])])
    const latency = (await req('project.pluginInfo', { uid: 'p2' })).latency
    check(latency === 8192, 'latência informada pelo plugin', String(latency))
  } else {
    console.log('(MFreeformPhase não instalado: teste de PDC pulado)')
  }

  // 6. Janela nativa.
  await sync([track('1', [slot(3)])])
  events.length = 0
  await req('project.openPluginEditor', { uid: 'p1' })
  await sleep(1500)
  check((await req('project.pluginInfo', { uid: 'p1' })).editorOpen, 'janela nativa aberta')
  await req('project.closePluginEditor', { uid: 'p1' })
  check(events.some(e => e.event === 'chain.editorClosed'), 'janela fechada avisa a interface')

  // 7. Plugin ausente: avisa e passa o som.
  events.length = 0
  const missing = await render([track('1', [{ uid: 'x', type: 'plugin', pluginId: 'VST3-Nao-Existe-0-0', enabled: true, stateVersion: 1, state: '' }])])
  check(events.some(e => e.event === 'chain.pluginError') && Math.abs(db(rms(missing), dry)) < 0.1, 'plugin ausente avisa e passa o som')
} catch (e) {
  failures++
  console.log('FALHA', e.message)
}

child.stdin.end()
console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo.')
process.exitCode = failures ? 1 : 0
