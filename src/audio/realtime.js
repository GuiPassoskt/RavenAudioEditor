// Efeitos em tempo real (não destrutivos), aplicados por faixa ou no master.
//
// No Audacity 3.2+ cada faixa tem uma RealtimeEffectList e o projeto tem a lista
// "Master" (lib-realtime-effects/RealtimeEffectList.h: Get(ChannelGroup) e
// Get(AudacityProject)). O RealtimeEffectManager processa primeiro a faixa e
// depois o master, e na exportação o Mixer aplica os mesmos estágios
// (lib-mixer/Mix.cpp, EffectStage). Aqui cada efeito vira um subgrafo de nós da
// Web Audio API. O mesmo código monta o grafo ao vivo e no OfflineAudioContext
// da exportação, então o que se ouve é o que se exporta.

const num = (key, label, def, min, max, step = 0.1, unit = '') =>
  ({ key, label, type: 'number', default: def, min, max, step, unit })
const sel = (key, label, def, options) => ({ key, label, type: 'select', default: def, options })

const db = v => Math.pow(10, v / 20)
// Durante a montagem (ou no render offline) o valor é aplicado direto; ao vivo,
// com uma rampa curta para evitar cliques.
let immediate = false
const ramp = (param, value, ctx) => {
  if (immediate || ctx instanceof OfflineAudioContext) param.value = value
  else param.setTargetAtTime(value, ctx.currentTime, 0.015)
}

// Resposta ao impulso sintética: ruído com decaimento exponencial, estéreo.
function impulse (ctx, seconds, damping) {
  const len = Math.max(1, Math.round(ctx.sampleRate * seconds))
  const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: ctx.sampleRate })
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2 + damping * 4)
      lp += (Math.random() * 2 - 1 - lp) * (1 - damping * 0.9) // abafamento dos agudos
      d[i] = lp * env
    }
  }
  return buf
}

function distortionCurve (driveDb) {
  const k = db(driveDb)
  const n = 2048
  const curve = new Float32Array(n)
  const norm = Math.tanh(k)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / norm
  }
  return curve
}

export const REALTIME_EFFECTS = [
  {
    id: 'gain',
    name: 'Ganho',
    source: 'lib-builtin-effects/AmplifyBase.cpp',
    params: [num('gain', 'Ganho', 0, -36, 36, 0.1, 'dB')],
    create (ctx) {
      const g = ctx.createGain()
      return { input: g, output: g, update: p => ramp(g.gain, db(p.gain), ctx) }
    }
  },
  {
    id: 'bassTreble',
    name: 'Graves e Agudos',
    source: 'lib-builtin-effects/BassTrebleBase.cpp',
    params: [
      num('bass', 'Graves (250 Hz)', 0, -30, 30, 0.1, 'dB'),
      num('treble', 'Agudos (4 kHz)', 0, -30, 30, 0.1, 'dB'),
      num('gain', 'Volume', 0, -30, 30, 0.1, 'dB')
    ],
    create (ctx) {
      const lo = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 })
      const hi = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000 })
      const g = ctx.createGain()
      lo.connect(hi).connect(g)
      return {
        input: lo,
        output: g,
        update: p => {
          ramp(lo.gain, p.bass, ctx)
          ramp(hi.gain, p.treble, ctx)
          ramp(g.gain, db(p.gain), ctx)
        }
      }
    }
  },
  {
    id: 'filter',
    name: 'Filtro',
    source: 'lib-builtin-effects/ScienFilterBase.cpp (simplificado)',
    params: [
      sel('type', 'Tipo', 'lowpass', [
        { label: 'Passa-baixa', value: 'lowpass' },
        { label: 'Passa-alta', value: 'highpass' }
      ]),
      num('freq', 'Corte', 1000, 20, 20000, 1, 'Hz'),
      sel('order', 'Inclinação', 2, [
        { label: '12 dB/oit', value: 1 },
        { label: '24 dB/oit', value: 2 },
        { label: '36 dB/oit', value: 3 },
        { label: '48 dB/oit', value: 4 }
      ])
    ],
    create (ctx) {
      // Quatro estágios fixos; os não usados viram passa-tudo (ganho unitário).
      const stages = Array.from({ length: 4 }, () => new BiquadFilterNode(ctx, { Q: Math.SQRT1_2 }))
      stages.reduce((a, b) => a.connect(b))
      return {
        input: stages[0],
        output: stages[3],
        update: p => stages.forEach((s, i) => {
          s.type = i < p.order ? p.type : 'allpass'
          ramp(s.frequency, Math.min(p.freq, ctx.sampleRate / 2 - 1), ctx)
        })
      }
    }
  },
  {
    id: 'echo',
    name: 'Eco',
    source: 'lib-builtin-effects/EchoBase.cpp',
    params: [
      num('delay', 'Atraso', 0.4, 0.01, 5, 0.01, 's'),
      num('decay', 'Decaimento', 0.4, 0, 0.95, 0.01)
    ],
    // y[n] = x[n] + decay · y[n - D]  (o mesmo laço de realimentação do EchoBase)
    create (ctx) {
      const sum = ctx.createGain()
      const delay = new DelayNode(ctx, { maxDelayTime: 5 })
      const fb = ctx.createGain()
      sum.connect(delay).connect(fb).connect(sum)
      return {
        input: sum,
        output: sum,
        update: p => {
          ramp(delay.delayTime, p.delay, ctx)
          ramp(fb.gain, p.decay, ctx)
        }
      }
    }
  },
  {
    id: 'reverb',
    name: 'Reverb',
    source: 'lib-builtin-effects/ReverbBase.cpp (convolução)',
    params: [
      num('time', 'Tempo de reverberação', 2, 0.1, 10, 0.1, 's'),
      num('damping', 'Abafamento', 0.5, 0, 1, 0.01),
      num('wet', 'Sinal processado (wet)', -6, -60, 6, 0.5, 'dB'),
      num('dry', 'Sinal original (dry)', 0, -60, 6, 0.5, 'dB')
    ],
    create (ctx) {
      const input = ctx.createGain()
      const output = ctx.createGain()
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      input.connect(dry).connect(output)
      wet.connect(output)
      let conv = null
      let ir = ''
      return {
        input,
        output,
        update: p => {
          ramp(dry.gain, db(p.dry), ctx)
          ramp(wet.gain, db(p.wet), ctx)
          const key = `${p.time}|${p.damping}`
          if (key !== ir) {
            // Trocar o buffer exige um ConvolverNode novo.
            ir = key
            const next = new ConvolverNode(ctx, { buffer: impulse(ctx, p.time, p.damping) })
            input.connect(next).connect(wet)
            if (conv) { input.disconnect(conv); conv.disconnect() }
            conv = next
          }
        }
      }
    }
  },
  {
    id: 'compressor',
    name: 'Compressor',
    source: 'lib-builtin-effects/CompressorInstance.cpp (DynamicsCompressorNode)',
    params: [
      num('threshold', 'Limiar', -18, -60, 0, 0.5, 'dB'),
      num('ratio', 'Razão', 4, 1, 20, 0.1, ':1'),
      num('knee', 'Joelho', 6, 0, 40, 0.5, 'dB'),
      num('attack', 'Ataque', 10, 0, 1000, 1, 'ms'),
      num('release', 'Liberação', 150, 10, 1000, 1, 'ms'),
      num('makeup', 'Ganho de compensação', 0, 0, 36, 0.5, 'dB')
    ],
    create (ctx) {
      const c = ctx.createDynamicsCompressor()
      const g = ctx.createGain()
      c.connect(g)
      return {
        input: c,
        output: g,
        update: p => {
          ramp(c.threshold, p.threshold, ctx)
          ramp(c.ratio, p.ratio, ctx)
          ramp(c.knee, p.knee, ctx)
          ramp(c.attack, p.attack / 1000, ctx)
          ramp(c.release, p.release / 1000, ctx)
          ramp(g.gain, db(p.makeup), ctx)
        }
      }
    }
  },
  {
    id: 'limiter',
    name: 'Limitador',
    source: 'lib-builtin-effects (Limiter, via DynamicsCompressorNode)',
    params: [
      num('ceiling', 'Teto', -1, -24, 0, 0.1, 'dB'),
      num('gain', 'Ganho de entrada', 0, 0, 24, 0.5, 'dB')
    ],
    create (ctx) {
      const pre = ctx.createGain()
      const c = new DynamicsCompressorNode(ctx, { ratio: 20, knee: 0, attack: 0.001, release: 0.05 })
      pre.connect(c)
      return {
        input: pre,
        output: c,
        update: p => {
          ramp(pre.gain, db(p.gain), ctx)
          ramp(c.threshold, p.ceiling, ctx)
        }
      }
    }
  },
  {
    id: 'distortion',
    name: 'Distorção',
    source: 'lib-builtin-effects/DistortionBase.cpp (soft clip)',
    params: [
      num('drive', 'Drive', 12, 0, 48, 0.5, 'dB'),
      num('output', 'Saída', -6, -36, 6, 0.5, 'dB')
    ],
    create (ctx) {
      const shaper = new WaveShaperNode(ctx, { oversample: '4x' })
      const g = ctx.createGain()
      shaper.connect(g)
      let drive = null
      return {
        input: shaper,
        output: g,
        update: p => {
          if (p.drive !== drive) { drive = p.drive; shaper.curve = distortionCurve(p.drive) }
          ramp(g.gain, db(p.output), ctx)
        }
      }
    }
  }
]

export const realtimeDef = id => REALTIME_EFFECTS.find(d => d.id === id)

export function realtimeDefaults (id) {
  return Object.fromEntries(realtimeDef(id).params.map(p => [p.key, p.default]))
}

// Monta a cadeia. Cada efeito ganha um "bypass" com crossfade (wet/dry), de modo
// que ligar e desligar não interrompe a reprodução — o equivalente a
// RealtimeEffectState::SetActive.
export function buildChain (ctx, effects) {
  const input = ctx.createGain()
  let tail = input
  const slots = new Map()
  for (const fx of effects) {
    const def = realtimeDef(fx.type)
    if (!def) continue
    const node = def.create(ctx)
    const out = ctx.createGain()
    const wet = ctx.createGain()
    const dry = ctx.createGain()
    tail.connect(node.input)
    node.output.connect(wet).connect(out)
    tail.connect(dry).connect(out)
    const slot = {
      update (params, enabled) {
        node.update(params)
        ramp(wet.gain, enabled ? 1 : 0, ctx)
        ramp(dry.gain, enabled ? 0 : 1, ctx)
      }
    }
    immediate = true
    try { slot.update(fx.params, fx.enabled) } finally { immediate = false }
    slots.set(fx.uid, slot)
    tail = out
  }
  return { input, output: tail, slots }
}

// Assinatura estrutural: se mudar (adicionar, remover, reordenar), a cadeia é
// reconstruída; se não, basta atualizar parâmetros nos nós existentes.
export const chainSignature = effects => effects.map(e => `${e.uid}:${e.type}`).join(',')
