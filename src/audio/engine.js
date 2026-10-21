// Motor de reprodução, captura e renderização baseado na Web Audio API.
//
// Equivalente simplificado do AudioIO do Audacity (lib-audio-io/AudioIO.cpp),
// que usa PortAudio e um thread de áudio próprio. No navegador, o próprio
// AudioContext agenda as fontes; nós só calculamos onde cada faixa começa.
//
// Grafo (o mesmo ao vivo e no OfflineAudioContext da exportação):
//
//   faixa: BufferSource -> [efeitos da faixa] -> upmix(2) -> Splitter -> gainL/gainR -> Merger ─┐
//   master: Σ faixas -> [efeitos master] -> fader master -> saída / medidores <───────────────┘
//
// O par gainL/gainR aplica a lei de pan linear do Audacity (ver buffer.channelVolumes),
// e a ordem faixa → master segue o RealtimeEffectManager.

import { channelVolumes, dbToLinear } from './buffer.js'
import { buildChain, chainSignature } from './realtime.js'
import { playNote } from './synth.js'

const LEAD = 0.05 // segundos de antecedência no agendamento
const MIDI_LOOKAHEAD = 0.3 // notas MIDI são agendadas aos poucos, 300 ms à frente

export const trackDuration = (track, rate) => (track.kind === 'midi' ? track.length : track.channels[0].length / rate)

const RECORDER_WORKLET = `
class RecorderProcessor extends AudioWorkletProcessor {
  process (inputs) {
    const input = inputs[0]
    if (input && input.length) this.port.postMessage(input.map(ch => ch.slice(0)))
    return true
  }
}
registerProcessor('rea-recorder', RecorderProcessor)
`

const bufferCache = new WeakMap()

// AudioBuffer não pertence a um contexto: o mesmo serve ao vivo e offline.
function audioBufferFor (track, rate) {
  const key = track.channels[0]
  let entry = bufferCache.get(key)
  if (!entry || entry.channels !== track.channels.length || entry.rate !== rate) {
    const buf = new AudioBuffer({ numberOfChannels: track.channels.length, length: Math.max(1, key.length), sampleRate: rate })
    track.channels.forEach((ch, i) => buf.copyToChannel(ch, i))
    entry = { buf, channels: track.channels.length, rate }
    bufferCache.set(key, entry)
  }
  return entry.buf
}

function createVoice (ctx, track, destination, withMeter) {
  const chain = buildChain(ctx, track.effects ?? [])
  // Converte mono em estéreo (L = R) para que o pan funcione depois de efeitos estéreo.
  const upmix = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  const splitter = ctx.createChannelSplitter(2)
  const merger = ctx.createChannelMerger(2)
  const gl = ctx.createGain()
  const gr = ctx.createGain()
  chain.output.connect(upmix).connect(splitter)
  splitter.connect(gl, 0)
  splitter.connect(gr, 1)
  gl.connect(merger, 0, 0)
  gr.connect(merger, 0, 1)
  merger.connect(destination)
  const voice = { chain, gl, gr, merger, sig: chainSignature(track.effects ?? []), sources: [], meters: null }
  if (withMeter) voice.meters = attachMeters(ctx, merger)
  return voice
}

function attachMeters (ctx, node) {
  const split = ctx.createChannelSplitter(2)
  node.connect(split)
  return [0, 1].map(i => {
    const a = ctx.createAnalyser()
    a.fftSize = 1024
    split.connect(a, i)
    return a
  })
}

// Monta o grafo de mixagem para [t0, t1] começando em `startAt` no relógio do contexto.
function buildGraph (ctx, { tracks, rate, t0, t1, startAt, master, applyMaster = true, meters = false }) {
  const masterIn = ctx.createGain()
  const masterChain = buildChain(ctx, applyMaster ? master.effects : [])
  const fader = ctx.createGain()
  fader.gain.value = applyMaster ? dbToLinear(master.gain) : 1
  masterIn.connect(masterChain.input)
  masterChain.output.connect(fader)

  const voices = new Map()
  const midi = []
  for (const track of tracks) {
    if (track.kind === 'midi') {
      // Faixa MIDI: as notas tocam no sintetizador e entram na cadeia de efeitos da faixa.
      const notes = track.notes
        .map(n => ({ ...n, g0: track.offset + n.start, g1: track.offset + n.start + n.dur }))
        .filter(n => n.g1 > t0 && n.g0 < t1)
        .sort((a, b) => a.g0 - b.g0)
      if (!notes.length) continue
      const voice = createVoice(ctx, track, masterIn, meters)
      voices.set(track.id, voice)
      midi.push({ voice, track, notes, idx: 0 })
      continue
    }
    const dur = track.channels[0].length / rate
    const segStart = Math.max(t0, track.offset)
    const segEnd = Math.min(t1, track.offset + dur)
    if (segEnd <= segStart) continue
    const voice = createVoice(ctx, track, masterIn, meters)
    const src = new AudioBufferSourceNode(ctx, { buffer: audioBufferFor(track, rate) })
    src.connect(voice.chain.input)
    src.start(startAt + (segStart - t0), segStart - track.offset, segEnd - segStart)
    voice.sources.push(src)
    voices.set(track.id, voice)
  }
  const graph = { masterIn, masterChain, fader, voices, midi, t0, t1, startAt, masterSig: chainSignature(applyMaster ? master.effects : []) }
  // Offline agenda tudo de uma vez; ao vivo, o agendador do motor vai agendando.
  if (ctx instanceof OfflineAudioContext) scheduleMidi(graph, Infinity)
  applyMix(graph, tracks, master, applyMaster, true)
  return graph
}

// Aplica ganho/pan/mute/solo e parâmetros dos efeitos sem reconstruir o grafo.
// Devolve false se a estrutura de alguma cadeia mudou (precisa reconstruir).
function applyMix (graph, tracks, master, applyMaster = true, immediate = false) {
  const ctx = graph.fader.context
  const set = (param, v) => {
    if (immediate || ctx instanceof OfflineAudioContext) param.value = v
    else param.setTargetAtTime(v, ctx.currentTime, 0.01)
  }
  let structureOk = true
  const anySolo = tracks.some(t => t.solo)
  for (const track of tracks) {
    const v = graph.voices.get(track.id)
    if (!v) continue
    const audible = !track.mute && (!anySolo || track.solo)
    const [l, r] = audible ? channelVolumes(track) : [0, 0]
    set(v.gl.gain, l)
    set(v.gr.gain, r)
    if (immediate) continue
    if (chainSignature(track.effects ?? []) !== v.sig) structureOk = false
    else for (const fx of track.effects ?? []) v.chain.slots.get(fx.uid)?.update(fx.params, fx.enabled)
  }
  if (applyMaster && !immediate) {
    set(graph.fader.gain, dbToLinear(master.gain))
    if (chainSignature(master.effects) !== graph.masterSig) structureOk = false
    else for (const fx of master.effects) graph.masterChain.slots.get(fx.uid)?.update(fx.params, fx.enabled)
  }
  return structureOk
}

// Agenda as notas cujo início cai antes de `horizon` (tempo do contexto).
function scheduleMidi (graph, horizon) {
  const ctx = graph.fader.context
  for (const m of graph.midi) {
    const { track } = m
    while (m.idx < m.notes.length) {
      const n = m.notes[m.idx]
      const when = graph.startAt + (Math.max(n.g0, graph.t0) - graph.t0)
      if (when > horizon) break
      m.idx++
      const end = Math.min(n.g1, graph.t1)
      const startAt = Math.max(when, ctx.currentTime)
      const dur = end - Math.max(n.g0, graph.t0) - (startAt - when)
      if (dur > 0.002) playNote(ctx, m.voice.chain.input, { pitch: n.pitch, vel: n.vel, program: track.program, drum: track.drum }, startAt, dur)
    }
  }
}

function teardown (graph) {
  if (!graph) return
  for (const v of graph.voices.values()) {
    for (const s of v.sources) {
      try { s.stop() } catch { /* já parado */ }
      s.disconnect()
    }
    v.merger.disconnect()
  }
  graph.fader.disconnect()
}

class AudioEngine {
  ctx = null
  out = null
  analysers = []
  graph = null
  playing = false
  startCtxTime = 0
  t0 = 0
  t1 = 0
  preview = null

  ensure (rate) {
    if (this.ctx && this.ctx.sampleRate === rate) return this.ctx
    if (this.ctx) this.ctx.close()
    this.ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' })
    this.out = this.ctx.createGain()
    this.out.connect(this.ctx.destination)
    this.analysers = attachMeters(this.ctx, this.out)
    this.workletReady = null
    return this.ctx
  }

  // Reproduz as faixas no intervalo [t0, t1] do tempo do projeto.
  async play (tracks, rate, t0, t1, master) {
    this.stop()
    const ctx = this.ensure(rate)
    if (ctx.state === 'suspended') await ctx.resume()
    const now = ctx.currentTime + LEAD
    this.graph = buildGraph(ctx, { tracks, rate, t0, t1, startAt: now, master, meters: true })
    this.graph.fader.connect(this.out)
    if (this.graph.midi.length) {
      const tick = () => this.graph && scheduleMidi(this.graph, ctx.currentTime + MIDI_LOOKAHEAD)
      tick()
      this.midiTimer = setInterval(tick, 50)
    }
    this.startCtxTime = now
    this.t0 = t0
    this.t1 = t1
    this.playing = true
  }

  // Atualiza o mix ao vivo. Retorna false se é preciso reiniciar (cadeia mudou).
  updateMix (tracks, master) {
    if (!this.graph) return true
    return applyMix(this.graph, tracks, master)
  }

  position () {
    if (!this.playing) return null
    return this.t0 + Math.max(0, this.ctx.currentTime - this.startCtxTime)
  }

  stop () {
    clearInterval(this.midiTimer)
    teardown(this.graph)
    this.graph = null
    this.stopPreview()
    this.playing = false
  }

  // Toca um trecho avulso (usado na "Prévia" dos efeitos, como EffectPreview.cpp).
  async playPreview (channels, rate) {
    this.stop()
    const ctx = this.ensure(rate)
    if (ctx.state === 'suspended') await ctx.resume()
    const buf = new AudioBuffer({ numberOfChannels: channels.length, length: Math.max(1, channels[0].length), sampleRate: rate })
    channels.forEach((ch, i) => buf.copyToChannel(ch, i))
    const src = new AudioBufferSourceNode(ctx, { buffer: buf })
    src.connect(this.out)
    src.start()
    this.preview = src
  }

  // Toca uma nota avulsa (clique no teclado do piano roll, criação de nota).
  async auditionNote (rate, pitch, program, drum, vel = 100) {
    const ctx = this.ensure(rate)
    if (ctx.state === 'suspended') await ctx.resume()
    playNote(ctx, this.out, { pitch, vel, program, drum }, ctx.currentTime + 0.01, 0.35)
  }

  stopPreview () {
    if (this.preview) {
      try { this.preview.stop() } catch { /* já parado */ }
      this.preview = null
    }
  }

  // Picos por canal de saída (0..1) para os medidores.
  meterLevels () {
    return this.analysers.length ? this.analysers.map(peakOfAnalyser) : [0, 0]
  }

  voiceLevels (trackId) {
    const v = this.graph?.voices.get(trackId)
    return v?.meters ? v.meters.map(peakOfAnalyser) : [0, 0]
  }

  // Renderiza a mixagem com todos os efeitos em tempo real (exportação,
  // "Mixar e renderizar", "Aplicar efeitos na faixa").
  async render ({ tracks, rate, t0, t1, master, applyMaster = true, channels = 2 }) {
    const length = Math.max(1, Math.round((t1 - t0) * rate))
    const ctx = new OfflineAudioContext(2, length, rate)
    const graph = buildGraph(ctx, { tracks, rate, t0, t1, startAt: 0, master, applyMaster })
    graph.fader.connect(ctx.destination)
    const rendered = await ctx.startRendering()
    const l = rendered.getChannelData(0)
    const r = rendered.getChannelData(1)
    if (channels === 2) return [new Float32Array(l), new Float32Array(r)]
    const mono = new Float32Array(length)
    for (let i = 0; i < length; i++) mono[i] = (l[i] + r[i]) / 2
    return [mono]
  }

  // ---- Captura (gravação) ----
  async startCapture (rate, onChunk, channels = 2) {
    const ctx = this.ensure(rate)
    if (ctx.state === 'suspended') await ctx.resume()
    if (!this.workletReady) {
      const url = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: 'application/javascript' }))
      this.workletReady = ctx.audioWorklet.addModule(url)
    }
    await this.workletReady
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: channels } }
    })
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'rea-recorder')
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    node.port.onmessage = e => onChunk(e.data)
    source.connect(node)
    source.connect(analyser)
    // O worklet precisa estar ligado ao destino para ser processado; ganho 0 evita retorno.
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(ctx.destination)
    this.capture = { stream, source, node, analyser, mute }
  }

  captureLevel () {
    return this.capture ? peakOfAnalyser(this.capture.analyser) : 0
  }

  stopCapture () {
    if (!this.capture) return
    const { stream, source, node, mute } = this.capture
    node.port.onmessage = null
    source.disconnect(); node.disconnect(); mute.disconnect()
    stream.getTracks().forEach(t => t.stop())
    this.capture = null
  }
}

const scratch = new Float32Array(1024)
function peakOfAnalyser (a) {
  a.getFloatTimeDomainData(scratch)
  let p = 0
  for (let i = 0; i < scratch.length; i++) p = Math.max(p, Math.abs(scratch[i]))
  return p
}

export const engine = new AudioEngine()
