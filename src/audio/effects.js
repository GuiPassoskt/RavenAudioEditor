// Catálogo de efeitos, geradores e analisadores.
//
// Cada entrada imita um efeito embutido do Audacity 3.7.9. A fonte original de
// cada algoritmo está indicada no campo `source` e detalhada em docs/ANALISE-AUDACITY.md.
//
// Contrato:
//   process(channels, params, { rate }) -> Float32Array[]   (efeitos)
//   generate(params, { rate, channels, length }) -> Float32Array[] (geradores)
// `channels` recebidos são cópias da região selecionada e podem ser modificados.

import { biquad, lowpass, highpass, lowShelf, highShelf } from './dsp.js'
import { concat, dbToLinear, linearToDb, peakOf, resampleLinear } from './buffer.js'

const num = (key, label, def, min, max, step = 0.1, unit = '') =>
  ({ key, label, type: 'number', default: def, min, max, step, unit })
const sel = (key, label, def, options) => ({ key, label, type: 'select', default: def, options })
const bool = (key, label, def) => ({ key, label, type: 'bool', default: def })

export const EFFECTS = [
  {
    id: 'amplify',
    name: 'Amplificar…',
    source: 'lib-builtin-effects/AmplifyBase.cpp',
    params: [
      num('amp', 'Amplificação', 0, -50, 50, 0.1, 'dB'),
      bool('clip', 'Permitir clipping', false)
    ],
    // Como no Audacity, o valor inicial leva o pico a 0 dB (mRatio = 1 / mPeak).
    prepare (channels) {
      const peak = peakOf(channels)
      return { amp: peak > 0 ? +(-linearToDb(peak)).toFixed(2) : 0, _peak: peak }
    },
    describe: p => p._peak > 0
      ? `Novo pico: ${(linearToDb(p._peak) + p.amp).toFixed(2)} dB`
      : 'A seleção está em silêncio.',
    process (channels, p) {
      const ratio = dbToLinear(p.amp)
      if (!p.clip && peakOf(channels) * ratio > 1.0001) {
        throw new Error('A amplificação causaria clipping. Reduza o valor ou marque "Permitir clipping".')
      }
      return channels.map(ch => ch.map(v => v * ratio))
    }
  },
  {
    id: 'normalize',
    name: 'Normalizar…',
    source: 'lib-builtin-effects/NormalizeBase.cpp',
    params: [
      num('peak', 'Pico máximo', -1, -145, 0, 0.1, 'dB'),
      bool('dc', 'Remover deslocamento DC', true),
      bool('independent', 'Normalizar canais estéreo independentemente', false)
    ],
    // Fase de análise (offset = -média, extent = max|x+offset|), depois
    // multiplicador = ratio / extent — idêntico ao NormalizeBase::Process.
    process (channels, p) {
      const ratio = dbToLinear(p.peak)
      const offsets = channels.map(ch => {
        if (!p.dc) return 0
        let sum = 0
        for (let i = 0; i < ch.length; i++) sum += ch[i]
        return -sum / ch.length
      })
      const extents = channels.map((ch, c) => {
        let e = 0
        for (let i = 0; i < ch.length; i++) e = Math.max(e, Math.abs(ch[i] + offsets[c]))
        return e
      })
      const maxExtent = Math.max(...extents)
      return channels.map((ch, c) => {
        const extent = p.independent ? extents[c] : maxExtent
        const mult = extent > 0 ? ratio / extent : 1
        return ch.map(v => (v + offsets[c]) * mult)
      })
    }
  },
  {
    id: 'fadein',
    name: 'Fade In',
    source: 'lib-builtin-effects/Fade.cpp',
    params: [],
    process: channels => channels.map(ch => {
      const n = ch.length
      return ch.map((v, i) => v * i / n)
    })
  },
  {
    id: 'fadeout',
    name: 'Fade Out',
    source: 'lib-builtin-effects/Fade.cpp',
    params: [],
    process: channels => channels.map(ch => {
      const n = ch.length
      return ch.map((v, i) => v * (n - 1 - i) / n)
    })
  },
  {
    id: 'reverse',
    name: 'Inverter no tempo (Reverse)',
    source: 'lib-builtin-effects/Reverse.cpp',
    params: [],
    process: channels => channels.map(ch => ch.slice().reverse())
  },
  {
    id: 'invert',
    name: 'Inverter polaridade (Invert)',
    source: 'lib-builtin-effects/Invert.cpp',
    params: [],
    process: channels => channels.map(ch => ch.map(v => -v))
  },
  {
    id: 'echo',
    name: 'Eco…',
    source: 'lib-builtin-effects/EchoBase.cpp',
    params: [
      num('delay', 'Atraso', 1, 0.001, 10, 0.01, 's'),
      num('decay', 'Fator de decaimento', 0.5, 0, 1, 0.01)
    ],
    // Buffer circular "history": out = in + history[pos] * decay; history[pos] = out
    process (channels, p, { rate }) {
      const histLen = Math.max(1, Math.round(rate * p.delay))
      return channels.map(ch => {
        const hist = new Float32Array(histLen)
        const out = new Float32Array(ch.length)
        let pos = 0
        for (let i = 0; i < ch.length; i++) {
          out[i] = ch[i] + hist[pos] * p.decay
          hist[pos] = out[i]
          if (++pos >= histLen) pos = 0
        }
        return out
      })
    }
  },
  {
    id: 'bassTreble',
    name: 'Graves e Agudos…',
    source: 'lib-builtin-effects/BassTrebleBase.cpp',
    params: [
      num('bass', 'Graves (250 Hz)', 0, -30, 30, 0.1, 'dB'),
      num('treble', 'Agudos (4 kHz)', 0, -30, 30, 0.1, 'dB'),
      num('gain', 'Volume', 0, -30, 30, 0.1, 'dB')
    ],
    process (channels, p, { rate }) {
      const lo = lowShelf(250, p.bass, 0.4, rate)
      const hi = highShelf(4000, p.treble, 0.4, rate)
      const g = dbToLinear(p.gain)
      return channels.map(ch => biquad(biquad(ch, lo), hi).map(v => v * g))
    }
  },
  {
    id: 'filter',
    name: 'Filtro passa-baixa / passa-alta…',
    source: 'lib-builtin-effects/ScienFilterBase.cpp (simplificado)',
    params: [
      sel('type', 'Tipo', 'lowpass', [
        { label: 'Passa-baixa', value: 'lowpass' },
        { label: 'Passa-alta', value: 'highpass' }
      ]),
      num('freq', 'Frequência de corte', 1000, 10, 22000, 1, 'Hz'),
      sel('order', 'Inclinação', 2, [
        { label: '12 dB/oitava', value: 1 },
        { label: '24 dB/oitava', value: 2 },
        { label: '36 dB/oitava', value: 3 },
        { label: '48 dB/oitava', value: 4 }
      ])
    ],
    process (channels, p, { rate }) {
      const freq = Math.min(p.freq, rate / 2 - 1)
      const c = p.type === 'lowpass' ? lowpass(freq, Math.SQRT1_2, rate) : highpass(freq, Math.SQRT1_2, rate)
      return channels.map(ch => {
        let out = ch
        for (let i = 0; i < p.order; i++) out = biquad(out, c)
        return out
      })
    }
  },
  {
    id: 'compressor',
    name: 'Compressor…',
    source: 'lib-builtin-effects/LegacyCompressorBase.cpp (simplificado)',
    params: [
      num('threshold', 'Limiar', -12, -60, 0, 0.5, 'dB'),
      num('ratio', 'Razão', 4, 1.1, 20, 0.1, ':1'),
      num('attack', 'Ataque', 10, 0.1, 1000, 0.1, 'ms'),
      num('release', 'Liberação', 150, 1, 5000, 1, 'ms'),
      bool('makeup', 'Ganho de compensação até 0 dB', true)
    ],
    process (channels, p, { rate }) {
      const aA = Math.exp(-1 / (rate * p.attack / 1000))
      const aR = Math.exp(-1 / (rate * p.release / 1000))
      const len = channels[0].length
      const out = channels.map(() => new Float32Array(len))
      let env = 0
      for (let i = 0; i < len; i++) {
        // Detector de pico ligado entre canais, como no compressor do Audacity.
        let x = 0
        for (const ch of channels) x = Math.max(x, Math.abs(ch[i]))
        env = x > env ? aA * env + (1 - aA) * x : aR * env + (1 - aR) * x
        const envDb = linearToDb(env)
        const gainDb = envDb > p.threshold ? (p.threshold - envDb) * (1 - 1 / p.ratio) : 0
        const g = dbToLinear(gainDb)
        for (let c = 0; c < channels.length; c++) out[c][i] = channels[c][i] * g
      }
      if (p.makeup) {
        const peak = peakOf(out)
        if (peak > 0) for (const ch of out) for (let i = 0; i < len; i++) ch[i] /= peak
      }
      return out
    }
  },
  {
    id: 'changeSpeed',
    name: 'Mudar velocidade…',
    source: 'lib-builtin-effects/ChangeSpeedBase.cpp',
    params: [num('percent', 'Variação da velocidade', 0, -90, 400, 0.1, '%')],
    // Muda tempo e tom juntos (reamostragem). Altera o comprimento da seleção.
    process: (channels, p) => channels.map(ch => resampleLinear(ch, 1 + p.percent / 100))
  },
  {
    id: 'repeat',
    name: 'Repetir…',
    source: 'lib-builtin-effects/RepeatBase.cpp',
    params: [num('count', 'Número de repetições', 1, 1, 100, 1)],
    process: (channels, p) => channels.map(ch => concat(Array(Math.round(p.count) + 1).fill(ch)))
  }
]

export const GENERATORS = [
  {
    id: 'tone',
    name: 'Tom…',
    source: 'lib-builtin-effects/ToneGenBase.cpp',
    params: [
      sel('wave', 'Forma de onda', 'sine', [
        { label: 'Senoide', value: 'sine' },
        { label: 'Quadrada', value: 'square' },
        { label: 'Dente de serra', value: 'sawtooth' },
        { label: 'Triangular', value: 'triangle' }
      ]),
      num('freq', 'Frequência', 440, 1, 22000, 1, 'Hz'),
      num('amp', 'Amplitude', 0.8, 0, 1, 0.01),
      num('duration', 'Duração', 5, 0.01, 3600, 0.1, 's')
    ],
    generate (p, { rate, channels, length }) {
      const out = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const phase = (i * p.freq / rate) % 1
        let v
        switch (p.wave) {
          case 'square': v = phase < 0.5 ? 1 : -1; break
          case 'sawtooth': v = 2 * phase - 1; break
          case 'triangle': v = 1 - 4 * Math.abs(phase - 0.5); break
          default: v = Math.sin(2 * Math.PI * phase)
        }
        out[i] = v * p.amp
      }
      return Array.from({ length: channels }, () => out)
    }
  },
  {
    id: 'noise',
    name: 'Ruído…',
    source: 'lib-builtin-effects/NoiseBase.cpp',
    params: [
      sel('type', 'Tipo de ruído', 'white', [
        { label: 'Branco', value: 'white' },
        { label: 'Rosa', value: 'pink' },
        { label: 'Marrom (Browniano)', value: 'brown' }
      ]),
      num('amp', 'Amplitude', 0.8, 0, 1, 0.01),
      num('duration', 'Duração', 5, 0.01, 3600, 0.1, 's')
    ],
    generate (p, { channels, length }) {
      return Array.from({ length: channels }, () => {
        const out = new Float32Array(length)
        let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0
        let brown = 0
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1
          if (p.type === 'pink') {
            // Filtro de Paul Kellet — o mesmo usado pelo NoiseBase do Audacity.
            b0 = 0.99886 * b0 + white * 0.0555179
            b1 = 0.99332 * b1 + white * 0.0750759
            b2 = 0.96900 * b2 + white * 0.1538520
            b3 = 0.86650 * b3 + white * 0.3104856
            b4 = 0.55000 * b4 + white * 0.5329522
            b5 = -0.7616 * b5 - white * 0.0168980
            out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11 * p.amp
            b6 = white * 0.115926
          } else if (p.type === 'brown') {
            brown = (brown + 0.02 * white) / 1.02
            out[i] = brown * 3.5 * p.amp
          } else {
            out[i] = white * p.amp
          }
        }
        return out
      })
    }
  },
  {
    id: 'dtmf',
    name: 'Tons DTMF…',
    source: 'lib-builtin-effects/DtmfBase.cpp',
    params: [
      { key: 'sequence', label: 'Sequência DTMF', type: 'text', default: '0123456789*#ABCD' },
      num('amp', 'Amplitude', 0.8, 0, 1, 0.01),
      num('duration', 'Duração total', 3, 0.1, 600, 0.1, 's'),
      num('duty', 'Proporção tom/silêncio', 55, 1, 99, 1, '%')
    ],
    generate (p, { rate, channels, length }) {
      const rows = { 1: 697, 2: 697, 3: 697, A: 697, 4: 770, 5: 770, 6: 770, B: 770, 7: 852, 8: 852, 9: 852, C: 852, '*': 941, 0: 941, '#': 941, D: 941 }
      const cols = { 1: 1209, 4: 1209, 7: 1209, '*': 1209, 2: 1336, 5: 1336, 8: 1336, 0: 1336, 3: 1477, 6: 1477, 9: 1477, '#': 1477, A: 1633, B: 1633, C: 1633, D: 1633 }
      const seq = [...String(p.sequence).toUpperCase()].filter(k => rows[k])
      const out = new Float32Array(length)
      if (seq.length) {
        const slot = length / seq.length
        const toneLen = Math.floor(slot * p.duty / 100)
        seq.forEach((k, n) => {
          const start = Math.floor(n * slot)
          for (let i = 0; i < toneLen && start + i < length; i++) {
            const t = i / rate
            out[start + i] = p.amp * 0.5 * (Math.sin(2 * Math.PI * rows[k] * t) + Math.sin(2 * Math.PI * cols[k] * t))
          }
        })
      }
      return Array.from({ length: channels }, () => out)
    }
  },
  {
    id: 'silence',
    name: 'Silêncio…',
    source: 'lib-builtin-effects/SilenceBase.cpp',
    params: [num('duration', 'Duração', 5, 0.01, 3600, 0.1, 's')],
    generate: (p, { channels, length }) => Array.from({ length: channels }, () => new Float32Array(length))
  }
]

export const ANALYZERS = [
  { id: 'spectrum', name: 'Plotar espectro…', source: 'lib-builtin-effects/PlotSpectrumBase.cpp' },
  { id: 'clipping', name: 'Encontrar clipping…', source: 'lib-builtin-effects/FindClippingBase.cpp' },
  { id: 'stats', name: 'Estatísticas da seleção…', source: 'src/effects/Contrast.cpp (RMS)' }
]

export function defaultsOf (def) {
  return Object.fromEntries(def.params.map(p => [p.key, p.default]))
}

// Regiões onde |x| >= limiar por pelo menos `minRun` amostras seguidas,
// como o FindClippingBase (parâmetros "start" e "stop").
export function findClipping (channels, rate, minRun = 3, threshold = 0.9999) {
  const hits = []
  channels.forEach((ch, c) => {
    let run = 0
    for (let i = 0; i <= ch.length; i++) {
      if (i < ch.length && Math.abs(ch[i]) >= threshold) { run++; continue }
      if (run >= minRun) hits.push({ channel: c, t0: (i - run) / rate, t1: i / rate, samples: run })
      run = 0
    }
  })
  return hits.sort((a, b) => a.t0 - b.t0)
}

export function stats (channels) {
  return channels.map(ch => {
    let sum = 0; let sq = 0; let peak = 0
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]
      sum += v; sq += v * v
      peak = Math.max(peak, Math.abs(v))
    }
    const n = ch.length || 1
    return { peakDb: linearToDb(peak), rmsDb: linearToDb(Math.sqrt(sq / n)), dc: sum / n }
  })
}
