// Sintetizador simples para faixas MIDI.
//
// O Audacity não sintetiza MIDI: lib-note-track/MIDIPlay.cpp envia as notas
// para um dispositivo externo via PortMidi. No navegador não há dispositivo
// garantido, então cada nota vira osciladores com envelope ADSR. O timbre
// depende da família General MIDI (programa / 8); o canal 10 é bateria.

export const INSTRUMENTS = [
  { label: 'Piano', value: 0 },
  { label: 'Percussão cromática', value: 8 },
  { label: 'Órgão', value: 16 },
  { label: 'Violão / Guitarra', value: 24 },
  { label: 'Baixo', value: 32 },
  { label: 'Cordas solo', value: 40 },
  { label: 'Ensemble de cordas', value: 48 },
  { label: 'Metais', value: 56 },
  { label: 'Palhetas', value: 64 },
  { label: 'Flautas', value: 72 },
  { label: 'Synth lead', value: 80 },
  { label: 'Synth pad', value: 88 },
  { label: 'Synth FX', value: 96 },
  { label: 'Étnicos', value: 104 },
  { label: 'Percussivos', value: 112 },
  { label: 'Efeitos sonoros', value: 120 },
  { label: 'Bateria (canal 10)', value: 128 }
]

export const instrumentLabel = (program, drum) =>
  drum ? INSTRUMENTS[16].label : INSTRUMENTS[Math.floor(program / 8)]?.label ?? 'Piano'

// osc: [tipo, multiplicador de frequência, ganho, desafinação em cents]
const FAMILIES = [
  { osc: [['triangle', 1, 0.7], ['sine', 2, 0.25], ['sine', 3, 0.08]], a: 0.004, d: 1.6, s: 0, r: 0.25, decayByPitch: true },
  { osc: [['sine', 1, 0.7], ['sine', 3.98, 0.25]], a: 0.002, d: 1.2, s: 0, r: 0.4 },
  { osc: [['sine', 1, 0.5], ['sine', 2, 0.3], ['square', 4, 0.06]], a: 0.01, d: 0.05, s: 1, r: 0.06 },
  { osc: [['sawtooth', 1, 0.5]], a: 0.003, d: 1.1, s: 0.05, r: 0.15, filter: [5000, 900, 0.4] },
  { osc: [['sawtooth', 1, 0.45], ['sine', 1, 0.5]], a: 0.005, d: 0.8, s: 0.35, r: 0.08, filter: [1400, 500, 0.3] },
  { osc: [['sawtooth', 1, 0.4, -6], ['sawtooth', 1, 0.4, 6]], a: 0.08, d: 0.2, s: 0.85, r: 0.25, filter: [3200, 3200, 1] },
  { osc: [['sawtooth', 1, 0.3, -9], ['sawtooth', 1, 0.3, 9], ['sawtooth', 2, 0.1]], a: 0.15, d: 0.2, s: 0.9, r: 0.4, filter: [2600, 2600, 1] },
  { osc: [['sawtooth', 1, 0.5]], a: 0.03, d: 0.15, s: 0.8, r: 0.1, filter: [3500, 1200, 0.15] },
  { osc: [['square', 1, 0.35], ['sawtooth', 1, 0.15]], a: 0.02, d: 0.1, s: 0.85, r: 0.08, filter: [2800, 2800, 1] },
  { osc: [['sine', 1, 0.7], ['triangle', 2, 0.1]], a: 0.04, d: 0.1, s: 0.9, r: 0.12 },
  { osc: [['square', 1, 0.35], ['sawtooth', 1, 0.15, 8]], a: 0.005, d: 0.1, s: 0.8, r: 0.08 },
  { osc: [['sawtooth', 1, 0.25, -12], ['sawtooth', 1, 0.25, 12], ['triangle', 0.5, 0.2]], a: 0.4, d: 0.5, s: 0.8, r: 0.8, filter: [1800, 1800, 1] },
  { osc: [['sawtooth', 1, 0.3], ['square', 1.5, 0.15]], a: 0.2, d: 0.6, s: 0.6, r: 0.6, filter: [2500, 800, 0.5] },
  { osc: [['triangle', 1, 0.5], ['sine', 2.01, 0.3]], a: 0.003, d: 0.9, s: 0.1, r: 0.2 },
  { osc: [['sine', 1, 0.8]], a: 0.001, d: 0.35, s: 0, r: 0.1 },
  { osc: [['sawtooth', 1, 0.3], ['square', 0.5, 0.3]], a: 0.01, d: 0.4, s: 0.4, r: 0.3, filter: [2000, 400, 0.4] }
]

const mtof = p => 440 * Math.pow(2, (p - 69) / 12)
let noiseBuf = null

function noise (ctx) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = new AudioBuffer({ numberOfChannels: 1, length: ctx.sampleRate, sampleRate: ctx.sampleRate })
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return new AudioBufferSourceNode(ctx, { buffer: noiseBuf, loop: true })
}

// Bateria GM: bumbo, caixa, chimbal, pratos e tons, por número de nota.
function drum (ctx, dest, pitch, when, vel) {
  const out = new GainNode(ctx, { gain: 0 })
  out.connect(dest)
  const v = vel * 0.9
  if (pitch === 35 || pitch === 36) {
    const o = new OscillatorNode(ctx, { type: 'sine' })
    o.frequency.setValueAtTime(150, when)
    o.frequency.exponentialRampToValueAtTime(45, when + 0.12)
    o.connect(out)
    out.gain.setValueAtTime(v, when)
    out.gain.exponentialRampToValueAtTime(0.001, when + 0.35)
    o.start(when); o.stop(when + 0.4)
    return
  }
  const isHat = [42, 44, 46].includes(pitch)
  const isCymbal = [49, 51, 52, 53, 55, 57, 59].includes(pitch)
  const isSnare = [37, 38, 39, 40].includes(pitch)
  if (isHat || isCymbal || isSnare) {
    const n = noise(ctx)
    const f = new BiquadFilterNode(ctx, { type: isSnare ? 'bandpass' : 'highpass', frequency: isSnare ? 1800 : 7000, Q: isSnare ? 0.7 : 0.5 })
    n.connect(f).connect(out)
    const len = isCymbal ? 1.2 : pitch === 46 ? 0.35 : isSnare ? 0.18 : 0.06
    out.gain.setValueAtTime(v * (isSnare ? 0.9 : 0.45), when)
    out.gain.exponentialRampToValueAtTime(0.001, when + len)
    n.start(when, Math.random() * 0.5); n.stop(when + len + 0.05)
    if (isSnare) {
      const o = new OscillatorNode(ctx, { type: 'triangle', frequency: 190 })
      const g = new GainNode(ctx, { gain: 0 })
      o.connect(g).connect(dest)
      g.gain.setValueAtTime(v * 0.5, when)
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.1)
      o.start(when); o.stop(when + 0.12)
    }
    return
  }
  // Tons e o resto: senoide com queda de afinação.
  const o = new OscillatorNode(ctx, { type: 'sine' })
  const base = 60 + (pitch - 41) * 12
  o.frequency.setValueAtTime(base * 1.6, when)
  o.frequency.exponentialRampToValueAtTime(Math.max(30, base), when + 0.15)
  o.connect(out)
  out.gain.setValueAtTime(v * 0.8, when)
  out.gain.exponentialRampToValueAtTime(0.001, when + 0.4)
  o.start(when); o.stop(when + 0.45)
}

// Agenda uma nota em `dest`. `when`/`dur` no relógio do contexto.
export function playNote (ctx, dest, { pitch, vel, program = 0, drum: isDrum = false }, when, dur) {
  const v = Math.pow(Math.max(1, vel) / 127, 1.5) * 0.3
  if (isDrum) return drum(ctx, dest, pitch, when, v)
  const fam = FAMILIES[Math.floor(program / 8)] ?? FAMILIES[0]
  const f0 = mtof(pitch)
  const env = new GainNode(ctx, { gain: 0 })
  let head = env
  let filter = null
  if (fam.filter) {
    const [peak, sustainHz, time] = fam.filter
    filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.8 })
    filter.frequency.setValueAtTime(Math.min(peak + f0 * 2, 18000), when)
    filter.frequency.setTargetAtTime(Math.min(sustainHz + f0, 18000), when + fam.a, time)
    filter.connect(env)
    head = filter
  }
  env.connect(dest)

  // Envelope ADSR. Notas graves do piano decaem mais devagar.
  const decay = fam.decayByPitch ? fam.d * Math.pow(2, (60 - pitch) / 24) : fam.d
  const end = when + dur
  env.gain.setValueAtTime(0, when)
  env.gain.linearRampToValueAtTime(v, when + fam.a)
  env.gain.setTargetAtTime(v * fam.s, when + fam.a, decay / 3)
  env.gain.cancelAndHoldAtTime?.(end)
  env.gain.setTargetAtTime(0, end, fam.r / 4)
  const stopAt = end + fam.r * 1.5

  for (const [type, mult, gain, cents = 0] of fam.osc) {
    const o = new OscillatorNode(ctx, { type, frequency: f0 * mult, detune: cents })
    const g = new GainNode(ctx, { gain })
    o.connect(g).connect(head)
    o.start(when)
    o.stop(stopAt)
  }
}
