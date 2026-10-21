// Operações sobre canais de amostras (Float32Array).
//
// Regra de ouro: NUNCA alterar um Float32Array existente. Toda edição devolve
// um array novo. Isso equivale ao compartilhamento de SampleBlocks imutáveis do
// Audacity (lib-wave-track/SampleBlock.h) e permite que o histórico de undo
// guarde apenas referências, sem copiar áudio.

export const DEFAULT_RATE = 44100

export function makeChannels (count, length) {
  return Array.from({ length: count }, () => new Float32Array(length))
}

export function clampInt (v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

export function removeRange (ch, s0, s1) {
  const out = new Float32Array(ch.length - (s1 - s0))
  out.set(ch.subarray(0, s0))
  out.set(ch.subarray(s1), s0)
  return out
}

// Insere `data` na posição `s`. Se `s` passar do fim, completa com silêncio.
export function insertAt (ch, s, data) {
  const base = Math.max(ch.length, s)
  const out = new Float32Array(base + data.length)
  out.set(ch.subarray(0, Math.min(s, ch.length)))
  out.set(data, s)
  if (s < ch.length) out.set(ch.subarray(s), s + data.length)
  return out
}

export function replaceRange (ch, s0, s1, data) {
  if (data.length === s1 - s0) {
    const out = ch.slice()
    out.set(data, s0)
    return out
  }
  return insertAt(removeRange(ch, s0, s1), s0, data)
}

export function concat (parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}

// Adapta uma lista de canais para `count` canais (mono <-> estéreo).
export function fitChannels (channels, count) {
  if (channels.length === count) return channels
  if (count === 1) {
    const out = new Float32Array(channels[0].length)
    for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length
    return [out]
  }
  return Array.from({ length: count }, (_, i) => channels[Math.min(i, channels.length - 1)])
}

// Reamostragem linear. O Audacity usa libsoxr (lib-src/libsoxr) com qualidade
// superior; aqui a interpolação linear é suficiente para um editor web.
export function resampleLinear (ch, factor) {
  const outLen = Math.max(1, Math.round(ch.length / factor))
  const out = new Float32Array(outLen)
  const last = ch.length - 1
  for (let i = 0; i < outLen; i++) {
    const pos = i * factor
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = ch[Math.min(i0, last)]
    const b = ch[Math.min(i0 + 1, last)]
    out[i] = a + (b - a) * frac
  }
  return out
}

export function peakOf (channels) {
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i])
      if (v > peak) peak = v
    }
  }
  return peak
}

export const dbToLinear = db => Math.pow(10, db / 20)
export const linearToDb = v => (v > 0 ? 20 * Math.log10(v) : -Infinity)

// Decodifica um arquivo de áudio já reamostrado para a taxa do projeto.
// decodeAudioData converte para a sampleRate do contexto que o chama.
export async function decodeFile (arrayBuffer, rate) {
  const ctx = new OfflineAudioContext(1, 1, rate)
  const audio = await ctx.decodeAudioData(arrayBuffer)
  return Array.from({ length: audio.numberOfChannels }, (_, i) => new Float32Array(audio.getChannelData(i)))
}

// Mixdown com a mesma lei de pan linear do Audacity
// (lib-wave-track/WaveTrack.cpp, WaveTrack::GetChannelVolume):
//   pan < 0 -> right = pan + 1 ; pan > 0 -> left = 1 - pan
export function channelVolumes (track) {
  const vol = dbToLinear(track.gain)
  let left = 1
  let right = 1
  if (track.pan < 0) right = track.pan + 1
  else if (track.pan > 0) left = 1 - track.pan
  return [left * vol, right * vol]
}

// Mixa faixas no intervalo [t0, t1) em `outChannels` canais.
export function mixdown (tracks, rate, t0, t1, outChannels = 2) {
  const len = Math.max(0, Math.round((t1 - t0) * rate))
  const out = makeChannels(outChannels, len)
  for (const track of tracks) {
    const [gl, gr] = channelVolumes(track)
    const gains = outChannels === 1 ? [(gl + gr) / 2] : [gl, gr]
    const startSample = Math.round((track.offset - t0) * rate)
    const n = track.channels.length
    for (let oc = 0; oc < outChannels; oc++) {
      const src = track.channels[Math.min(oc, n - 1)]
      const g = gains[oc]
      // Faixa mono em saída estéreo: o mesmo canal alimenta L e R.
      const from = Math.max(0, -startSample)
      const to = Math.min(src.length, len - startSample)
      const dst = out[oc]
      if (outChannels === 1 && n > 1) {
        for (let i = from; i < to; i++) {
          let s = 0
          for (let c = 0; c < n; c++) s += track.channels[c][i]
          dst[i + startSample] += (s / n) * g
        }
      } else {
        for (let i = from; i < to; i++) dst[i + startSample] += src[i] * g
      }
    }
  }
  return out
}
