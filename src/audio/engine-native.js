// Motor de áudio nativo (raven-engine, Fase 2 de docs/INTEGRACAO-PLUGINS-NATIVOS.md).
//
// Mesma interface do motor Web Audio de engine.js (play, stop, position,
// updateMix, render, prévia, captura…), mas a mixagem, os efeitos em tempo real,
// o sintetizador e a entrada/saída de áudio rodam no processo C++ com JUCE
// (engine/src/AudioEngine.cpp). Só existe no app desktop.
//
// O áudio das faixas continua morando na interface: cada Float32Array vira um
// "clipe" enviado ao motor uma vez e reaproveitado enquanto não mudar.

import { call } from './plugins.js'

const bridge = typeof window !== 'undefined' ? window.audio : undefined

const METERS_STALE_MS = 200 // sem medidores recentes, os níveis caem a zero
const CAPTURE_POLL_MS = 100 // a gravação é lida do motor a cada 100 ms

const isAudio = t => t.kind !== 'midi'
const request = (cmd, args) => call(() => bridge.request(cmd, args))

export class NativeAudioEngine {
  kind = 'native'
  playing = false
  previewing = false

  #rate = 44100
  #t0 = 0
  #t1 = 0
  #startedAt = 0
  #ended = false
  #meters = null
  #metersAt = 0
  #capture = null
  #queue = Promise.resolve() // sincronizações e uploads em ordem

  #clipIds = new WeakMap() // canal 0 (Float32Array) -> { id, channels }
  #nextClip = 1
  #uploaded = new Set() // clipes que o motor tem
  #uploading = new Map() // id -> Promise
  #notesSent = new Map() // id da faixa -> notesKey enviado
  #statesSent = new Map() // uid do plugin -> stateVersion que o motor já tem

  constructor () {
    bridge.onEvent((name, msg) => this.#onEvent(name, msg))
  }

  #onEvent (name, msg) {
    if (name === 'meters') {
      this.#meters = msg
      this.#metersAt = performance.now()
    } else if (name === 'transport.ended') {
      this.#ended = true
    } else if (name === 'ready' || name === 'engine.exit') {
      // Motor (re)iniciado: perdeu clipes, notas e reprodução.
      this.#uploaded.clear()
      this.#notesSent.clear()
      this.#statesSent.clear()
      this.#ended = true
    }
  }

  // ---- Clipes e projeto ----
  #clipId (channels) {
    let entry = this.#clipIds.get(channels[0])
    if (!entry || entry.channels !== channels.length) {
      entry = { id: `c${this.#nextClip++}`, channels: channels.length }
      this.#clipIds.set(channels[0], entry)
    }
    return entry.id
  }

  #ensureClip (channels) {
    const id = this.#clipId(channels)
    if (this.#uploaded.has(id)) return Promise.resolve()
    if (!this.#uploading.has(id)) {
      const job = call(() => bridge.sendAudio('clips.load', { clipId: id }, channels))
        .then(() => this.#uploaded.add(id))
        .finally(() => this.#uploading.delete(id))
      this.#uploading.set(id, job)
    }
    return this.#uploading.get(id)
  }

  #ensureClips (tracks) {
    return Promise.all(tracks.filter(t => isAudio(t) && t.channels[0]?.length).map(t => this.#ensureClip(t.channels)))
  }

  // Efeito no formato do motor. Plugins: o estado (que pode ter centenas de KB)
  // só vai quando a versão muda, exceto no render offline (all).
  #fxJson (fx, all) {
    const uid = String(fx.uid)
    if (fx.type !== 'plugin') return { uid, type: fx.type, enabled: fx.enabled, params: { ...fx.params } }
    const json = { uid, type: 'plugin', enabled: fx.enabled, pluginId: fx.plugin.id, stateVersion: fx.stateVersion }
    if (all || this.#statesSent.get(uid) !== fx.stateVersion) {
      json.state = fx.state ?? ''
      if (!all) this.#statesSent.set(uid, fx.stateVersion)
    }
    return json
  }

  // O estado veio do próprio motor (chain.pluginState): não precisa voltar para ele.
  markPluginStateSent (uid, stateVersion) {
    this.#statesSent.set(String(uid), stateVersion)
  }

  // Projeto no formato de MixGraph::build. As notas só vão quando mudam
  // (notesKey = versão da faixa), exceto no render offline (allNotes).
  #projectJson (tracks, master, rate, allNotes = false) {
    const fxJson = fx => this.#fxJson(fx, allNotes)
    // A entrada MIDI toca na faixa MIDI selecionada.
    const midiTarget = tracks.find(t => t.kind === 'midi' && t.selected)
    return {
      rate,
      midiTarget: midiTarget ? String(midiTarget.id) : null,
      master: { gain: master.gain, effects: master.effects.map(fxJson) },
      tracks: tracks.map(t => {
        const json = {
          id: String(t.id), kind: t.kind, offset: t.offset, gain: t.gain, pan: t.pan,
          mute: t.mute, solo: t.solo, effects: (t.effects ?? []).map(fxJson)
        }
        if (isAudio(t)) return { ...json, clip: t.channels[0]?.length ? this.#clipId(t.channels) : null }

        Object.assign(json, {
          program: t.program, drum: t.drum, notesKey: String(t.version),
          instrument: t.instrument ? this.#fxJson(t.instrument, allNotes) : null
        })
        if (allNotes || this.#notesSent.get(json.id) !== json.notesKey) {
          json.notes = t.notes.map(n => ({ start: n.start, dur: n.dur, pitch: n.pitch, vel: n.vel }))
          if (!allNotes) this.#notesSent.set(json.id, json.notesKey)
        }
        return json
      })
    }
  }

  // Clipes que saíram do projeto (o desfazer reenvia se precisar).
  #releaseUnused (tracks) {
    const live = new Set(tracks.filter(t => isAudio(t) && t.channels[0]?.length).map(t => this.#clipId(t.channels)))
    const unused = [...this.#uploaded].filter(id => !live.has(id))
    if (!unused.length) return
    unused.forEach(id => this.#uploaded.delete(id))
    request('clips.release', { ids: unused }).catch(() => {})
  }

  #sync (tracks, master, rate) {
    this.#rate = rate
    const job = this.#queue.then(async () => {
      await this.#ensureClips(tracks)
      await request('project.sync', this.#projectJson(tracks, master, rate))
      this.#releaseUnused(tracks)
    })
    this.#queue = job.catch(() => {})
    return job
  }

  // ---- Transporte ----
  async play (tracks, rate, t0, t1, master) {
    this.stopPreview()
    await this.#sync(tracks, master, rate)
    await request('transport.play', { t0, t1 })
    this.playing = true
    this.#t0 = t0
    this.#t1 = t1
    this.#ended = false
    this.#meters = null
    this.#startedAt = performance.now()
  }

  // Projeto atualizado no motor com o transporte parado (plugins das cadeias).
  syncIdle (tracks, master, rate) {
    return this.#sync(tracks, master, rate).catch(e => console.error('[motor nativo]', e))
  }

  // O motor nativo troca o grafo sem parar: nunca precisa reiniciar a reprodução.
  updateMix (tracks, master) {
    this.#sync(tracks, master, this.#rate).catch(e => console.error('[motor nativo]', e))
    return true
  }

  position () {
    if (!this.playing) return null
    if (this.#ended) return this.#t1
    const m = this.#meters
    if (!m || this.#metersAt < this.#startedAt || !m.playing) return this.#t0
    // Entre um evento e outro (30 por segundo), a posição é extrapolada.
    return Math.min(this.#t1, m.position + (performance.now() - this.#metersAt) / 1000)
  }

  stop () {
    if (this.playing) request('transport.stop').catch(() => {})
    this.playing = false
    this.stopPreview()
  }

  // ---- Prévia e notas avulsas ----
  async playPreview (channels, rate) {
    this.stop()
    await call(() => bridge.sendAudio('preview.play', { rate }, channels))
    this.previewing = true
  }

  stopPreview () {
    if (this.previewing) request('preview.stop').catch(() => {})
    this.previewing = false
  }

  // Com trackId, a nota toca pela própria faixa (instrumento VSTi e efeitos).
  auditionNote (rate, pitch, program, drum, vel = 100, trackId = null) {
    return request('synth.audition', { pitch, program, drum, vel, ...(trackId != null ? { trackId: String(trackId) } : {}) })
  }

  // ---- Medidores ----
  #fresh () {
    return this.#meters && performance.now() - this.#metersAt < METERS_STALE_MS
  }

  meterLevels () {
    return this.#fresh() ? this.#meters.master : [0, 0]
  }

  voiceLevels (trackId) {
    return (this.#fresh() && this.#meters.tracks?.[String(trackId)]) || [0, 0]
  }

  captureLevel () {
    return this.#fresh() ? this.#meters.input : 0
  }

  // ---- Render offline (exportar, mixar, aplicar efeitos, MIDI em áudio) ----
  async render ({ tracks, rate, t0, t1, master, applyMaster = true, channels = 2 }) {
    await this.#queue
    await this.#ensureClips(tracks)
    const project = this.#projectJson(tracks, master, rate, true)
    const [l, r] = await call(() => bridge.receiveAudio('render.offline', { project, t0, t1, applyMaster }))
    if (channels === 2) return [l, r]
    const mono = new Float32Array(l.length)
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2
    return [mono]
  }

  // ---- Captura (gravação) ----
  // Devolve { latency }: latência de ida e volta do driver, em segundos (o store
  // descarta esse trecho do começo do take).
  async startCapture (rate, onChunk, channels = 2) {
    await request('project.setRate', { rate })
    const info = await request('capture.start', { channels })
    this.#capture = { onChunk, reading: null, timer: setInterval(() => this.#readCapture(), CAPTURE_POLL_MS) }
    return info
  }

  // ---- Entrada e gravação MIDI ----
  startMidiRecording () {
    return request('midi.startRecording')
  }

  readMidiRecording () {
    return request('midi.read')
  }

  stopMidiRecording () {
    return request('midi.stopRecording')
  }

  midiActivity () {
    return !!(this.#fresh() && this.#meters.midiIn)
  }

  #readCapture () {
    const capture = this.#capture
    if (!capture) return Promise.resolve()
    if (!capture.reading) {
      capture.reading = call(() => bridge.receiveAudio('capture.read', {}))
        .then(chunk => { if (chunk[0].length) capture.onChunk(chunk) })
        .catch(e => console.error('[motor nativo] gravação', e))
        .finally(() => { capture.reading = null })
    }
    return capture.reading
  }

  // Assíncrono: lê o que ainda está no motor antes de parar.
  async stopCapture () {
    const capture = this.#capture
    if (!capture) return
    clearInterval(capture.timer)
    await capture.reading
    await this.#readCapture()
    this.#capture = null
    await request('capture.stop').catch(() => {})
  }

  // ---- Informações (tela de abertura, diálogo de dispositivos) ----
  status () {
    return request('audio.status')
  }
}

// Usa o motor nativo se ele existir e tiver aberto o dispositivo de áudio.
export async function createNativeEngine () {
  if (!bridge) return null
  const { available } = await call(() => bridge.engineStatus())
  if (!available) return null
  const info = await request('ping')
  if (info.audio?.error) {
    console.warn('[motor nativo] dispositivo de áudio indisponível:', info.audio.error)
    return null
  }
  restoreMidiInput().catch(e => console.warn('[motor nativo] entrada MIDI:', e.message))
  return new NativeAudioEngine()
}

// Diálogo "Dispositivos de áudio": drivers (Windows Audio, ASIO…), saídas,
// entradas, taxas e tamanhos de buffer, e a troca do dispositivo (salva entre sessões).
export const audioDevices = () => request('audio.devices')
export const setAudioDevice = settings => request('audio.setDevice', settings)

// Entrada MIDI (teclado/controlador), lembrada entre sessões.
const MIDI_INPUT_KEY = 'raven.midi.input'
export const midiDevices = () => request('midi.devices')
export async function setMidiInput (id) {
  await request('midi.setInput', { id: id ?? '' })
  try { localStorage.setItem(MIDI_INPUT_KEY, id ?? '') } catch { /* sem storage */ }
}
async function restoreMidiInput () {
  let id = ''
  try { id = localStorage.getItem(MIDI_INPUT_KEY) ?? '' } catch { /* sem storage */ }
  if (!id) return
  const { inputs } = await midiDevices()
  if (inputs.some(d => d.id === id)) await request('midi.setInput', { id })
}

// Plugins nas cadeias em tempo real (Fase 3): informações, parâmetros e janela
// nativa de um slot, pelo uid do efeito.
export const chainPlugin = {
  info: uid => request('project.pluginInfo', { uid: String(uid) }),
  setParam: (uid, index, value) => request('project.setPluginParam', { uid: String(uid), index, value }),
  openEditor: uid => request('project.openPluginEditor', { uid: String(uid) }),
  closeEditor: uid => request('project.closePluginEditor', { uid: String(uid) })
}
