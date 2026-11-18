// Teste do motor nativo sem interface: ping, lista de plugins e processamento.
//
//   RAVEN_PLUGIN_CACHE=<arquivo xml> node engine-smoke.mjs <raven-engine.exe> <pasta-temporária>
//
// A lista precisa existir (rode antes "raven-engine.exe --scan" com as mesmas variáveis).
// Precisa do plugin "kHs Gain" (Kilohearts Essentials). Sai com código 1 em falha.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [exe, dir] = process.argv.slice(2)
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
let id = 0
readline.createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line)
  if (!pending.has(m.id)) return
  const { res, rej } = pending.get(m.id)
  pending.delete(m.id)
  m.ok ? res(m.result) : rej(new Error(m.error))
})
const req = (cmd, args = {}) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, { res, rej })
  child.stdin.write(JSON.stringify({ ...args, id: i, cmd }) + '\n')
})

const rate = 48000
const frames = rate
const sine = new Float32Array(frames).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / rate))
const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)
const input = path.join(dir, 'in.f32')
const output = path.join(dir, 'out.f32')
writeFileSync(input, Buffer.concat([Buffer.from(sine.buffer), Buffer.from(sine.buffer)]))

let ok = true
try {
  const info = await req('ping')
  console.log('ping:', info.name, info.version, info.juce, info.formats.join('/'))
  const list = await req('plugins.list')
  console.log('plugins na lista:', list.length)
  const plugin = list.find(p => p.name === 'kHs Gain')
  if (!plugin) throw new Error('kHs Gain não está na lista')
  const inst = await req('fx.create', { pluginId: plugin.id, sampleRate: rate })
  const gain = inst.params.find(p => p.name === 'Gain')
  const set = await req('fx.setParam', { instanceId: inst.instanceId, index: gain.index, value: 0.2 })
  await req('fx.process', { instanceId: inst.instanceId, sampleRate: rate, channels: 2, frames, input, output })
  const out = new Float32Array(readFileSync(output).buffer.slice(0, frames * 4))
  const expected = rms(sine) * 10 ** (-18 / 20)
  ok = Math.abs(rms(out) - expected) < 0.001
  console.log(`Gain ${set.text}: RMS ${rms(out).toFixed(4)} (esperado ${expected.toFixed(4)}) ${ok ? 'OK' : 'FALHA'}`)
  await req('fx.destroy', { instanceId: inst.instanceId })
} catch (e) {
  ok = false
  console.log('FALHA', e.message)
}
child.stdin.end()
process.exitCode = ok ? 0 : 1
