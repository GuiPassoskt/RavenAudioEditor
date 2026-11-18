// Ponte entre o Electron e o motor de áudio nativo (raven-engine, feito com JUCE).
//
// O motor roda em processo separado (docs/INTEGRACAO-PLUGINS-NATIVOS.md, seção 4.2):
// se um plugin travar, cai só o motor, e ele é reiniciado aqui.
//   - controle: uma mensagem JSON por linha no stdin/stdout (engine/src/Protocol.h);
//   - áudio: arquivos temporários Float32 planares (um canal depois do outro).

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const MAX_RESTARTS = 3
const SCAN_IDLE_TIMEOUT = 60_000 // sem progresso por 60 s: um plugin travou a varredura
const SCAN_MAX_ATTEMPTS = 10 // cada queda põe um plugin na lista negra e recomeça

const MISSING_MESSAGE = 'Motor de áudio nativo não encontrado. Compile-o com "npm run build:engine".'

export function findEngineBinary () {
  if (process.env.RAVEN_ENGINE_PATH) return process.env.RAVEN_ENGINE_PATH
  const dir = import.meta.env.QUASAR_DEV
    ? path.join(app.getAppPath(), '../../../engine/bin')
    : process.resourcesPath
  if (process.platform === 'win32') return path.join(dir, 'raven-engine.exe')
  if (process.platform === 'darwin') return path.join(dir, 'raven-engine.app/Contents/MacOS/raven-engine')
  return path.join(dir, 'raven-engine')
}

export class EngineHost {
  constructor ({ onEvent }) {
    this.onEvent = onEvent
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.restarts = 0
    this.stopping = false
    this.scanning = null
  }

  get pluginDir () {
    return path.join(app.getPath('userData'), 'plugins')
  }

  get env () {
    return {
      ...process.env,
      RAVEN_PLUGIN_CACHE: path.join(this.pluginDir, 'known-plugins.xml'),
      RAVEN_SCAN_PEDAL: path.join(this.pluginDir, 'scan-in-progress.txt')
    }
  }

  status () {
    const binary = findEngineBinary()
    return { available: existsSync(binary), running: !!this.child, binary }
  }

  start () {
    if (this.child || this.stopping) return
    const binary = findEngineBinary()
    if (!existsSync(binary)) return

    // windowsHide precisa ficar desligado: com ele, a primeira janela de plugin abriria oculta.
    const child = spawn(binary, [], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    readline.createInterface({ input: child.stdout }).on('line', line => this.#onLine(line))
    readline.createInterface({ input: child.stderr }).on('line', line => console.warn('[raven-engine]', line))
    child.stdin.on('error', () => { /* o motor caiu; tratado no "exit" */ })

    child.on('error', err => console.error('[raven-engine] falha ao iniciar:', err))
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null
      for (const { reject } of this.pending.values()) reject(new Error('O motor de áudio foi encerrado.'))
      this.pending.clear()
      if (this.stopping) return
      this.onEvent('engine.exit', { code, signal })
      if (this.restarts++ < MAX_RESTARTS) this.start()
    })
  }

  #onLine (line) {
    let msg
    try { msg = JSON.parse(line) } catch { return console.warn('[raven-engine]', line) }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    } else if (msg.event) {
      if (msg.event === 'ready') this.restarts = 0
      this.onEvent(msg.event, msg)
    }
  }

  request (cmd, args = {}) {
    this.start()
    if (!this.child) return Promise.reject(new Error(MISSING_MESSAGE))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ ...args, id, cmd }) + '\n')
    })
  }

  // Passa um trecho de áudio (Float32Array por canal) pelo plugin aberto em instanceId.
  async process (instanceId, channels, sampleRate) {
    const dir = path.join(os.tmpdir(), 'raven-engine')
    await mkdir(dir, { recursive: true })
    const base = path.join(dir, randomUUID())
    const input = `${base}-in.f32`
    const output = `${base}-out.f32`
    const frames = channels[0]?.length ?? 0

    try {
      await writeFile(input, Buffer.concat(channels.map(ch => Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength))))
      await this.request('fx.process', { instanceId, sampleRate, channels: channels.length, frames, input, output })
      const data = await readFile(output)
      const bytes = frames * Float32Array.BYTES_PER_ELEMENT
      return channels.map((_, c) => new Float32Array(data.buffer.slice(data.byteOffset + c * bytes, data.byteOffset + (c + 1) * bytes)))
    } finally {
      await rm(input, { force: true })
      await rm(output, { force: true })
    }
  }

  // Procura plugins instalados num processo à parte ("raven-engine --scan").
  scan ({ full = false } = {}) {
    this.scanning ??= this.#runScan(full).finally(() => { this.scanning = null })
    return this.scanning
  }

  async #runScan (full) {
    const binary = findEngineBinary()
    if (!existsSync(binary)) throw new Error(MISSING_MESSAGE)
    await mkdir(this.pluginDir, { recursive: true })
    if (full) await rm(this.env.RAVEN_PLUGIN_CACHE, { force: true })

    for (let attempt = 1; attempt <= SCAN_MAX_ATTEMPTS; attempt++) {
      if (await this.#scanOnce(binary) === 0) break
      this.onEvent('scan.crashed', { attempt })
    }
    return this.request('plugins.list')
  }

  #scanOnce (binary) {
    return new Promise(resolve => {
      const child = spawn(binary, ['--scan'], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let timer
      const arm = () => {
        clearTimeout(timer)
        // Matar o processo deixa o plugin no "dead man's pedal": a próxima tentativa o pula.
        timer = setTimeout(() => child.kill(), SCAN_IDLE_TIMEOUT)
      }
      arm()

      readline.createInterface({ input: child.stdout }).on('line', line => {
        arm()
        try {
          const msg = JSON.parse(line)
          if (msg.event) this.onEvent(msg.event, msg)
        } catch { /* linha que não é do protocolo */ }
      })
      readline.createInterface({ input: child.stderr }).on('line', line => console.warn('[raven-engine --scan]', line))

      child.on('error', () => { clearTimeout(timer); resolve(-1) })
      child.on('exit', code => { clearTimeout(timer); resolve(code ?? -1) })
    })
  }

  stop () {
    this.stopping = true
    const child = this.child
    if (!child) return
    child.stdin.end() // o motor termina sozinho quando o stdin fecha
    setTimeout(() => child.kill(), 2000).unref()
  }
}
