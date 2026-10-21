// Resumo de amostras para desenho rápido do waveform.
//
// O Audacity guarda, para cada SampleBlock, resumos (min, max, rms) a cada 256
// e a cada 65536 amostras (lib-wave-track/SampleBlock.h: GetSummary256/64k;
// lib-wave-track-paint/waveform/WaveDataCache.cpp: MinMaxRMS256/MinMaxRMS64k).
// Na hora de pintar, cada coluna de pixel consulta o nível de resumo mais
// grosso que ainda cabe nela. Aqui fazemos o mesmo com dois níveis.

export const BLOCK = 256
const BLOCK_BIG = 65536
const cache = new WeakMap()

function build (data, source, sourceBlock, ratio) {
  const n = Math.ceil(source.length / ratio)
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  const sq = new Float32Array(n) // soma de quadrados
  for (let b = 0; b < n; b++) {
    let lo = Infinity; let hi = -Infinity; let s = 0
    const end = Math.min(source.length, (b + 1) * ratio)
    for (let i = b * ratio; i < end; i++) {
      if (sourceBlock) {
        lo = Math.min(lo, sourceBlock.min[i]); hi = Math.max(hi, sourceBlock.max[i]); s += sourceBlock.sq[i]
      } else {
        const v = data[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
        s += v * v
      }
    }
    min[b] = lo; max[b] = hi; sq[b] = s
  }
  return { min, max, sq, length: n }
}

export function getSummary (ch) {
  let s = cache.get(ch)
  if (!s) {
    const s256 = build(ch, ch, null, BLOCK)
    const s64k = build(null, { length: s256.length }, s256, BLOCK_BIG / BLOCK)
    s = { s256, s64k }
    cache.set(ch, s)
  }
  return s
}

// Estatísticas (min, max, rms) do intervalo de amostras [a, b).
export function rangeStats (ch, a, b) {
  a = Math.max(0, Math.floor(a))
  b = Math.min(ch.length, Math.ceil(b))
  if (b <= a) return null
  let lo = Infinity; let hi = -Infinity; let sq = 0
  const span = b - a
  if (span >= BLOCK * 4) {
    const { s256, s64k } = getSummary(ch)
    const useBig = span >= BLOCK_BIG * 4
    const level = useBig ? s64k : s256
    const size = useBig ? BLOCK_BIG : BLOCK
    const b0 = Math.floor(a / size)
    const b1 = Math.min(level.length, Math.ceil(b / size))
    for (let k = b0; k < b1; k++) {
      if (level.min[k] < lo) lo = level.min[k]
      if (level.max[k] > hi) hi = level.max[k]
      sq += level.sq[k]
    }
    return { min: lo, max: hi, rms: Math.sqrt(sq / ((b1 - b0) * size)) }
  }
  for (let i = a; i < b; i++) {
    const v = ch[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
    sq += v * v
  }
  return { min: lo, max: hi, rms: Math.sqrt(sq / span) }
}
