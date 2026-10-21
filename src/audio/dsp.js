// Filtros e utilidades de DSP usados pelos efeitos.

// Biquad (forma direta I) com coeficientes do "Audio EQ Cookbook" (R. Bristow-Johnson).
export function biquad (input, c) {
  const out = new Float32Array(input.length)
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0
  const { b0, b1, b2, a1, a2 } = c
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    out[i] = y
  }
  return out
}

function normalize (b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

export function lowpass (freq, q, rate) {
  const w0 = 2 * Math.PI * freq / rate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return normalize((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
}

export function highpass (freq, q, rate) {
  const w0 = 2 * Math.PI * freq / rate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return normalize((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
}

// Shelving com parâmetro de inclinação S — o mesmo esquema do Bass & Treble do
// Audacity (lib-builtin-effects/BassTrebleBase.cpp, slope = 0.4).
function shelf (type, freq, gainDb, slope, rate) {
  const A = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * freq / rate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2)
  const sq = 2 * Math.sqrt(A) * alpha
  if (type === 'low') {
    return normalize(
      A * ((A + 1) - (A - 1) * cos + sq),
      2 * A * ((A - 1) - (A + 1) * cos),
      A * ((A + 1) - (A - 1) * cos - sq),
      (A + 1) + (A - 1) * cos + sq,
      -2 * ((A - 1) + (A + 1) * cos),
      (A + 1) + (A - 1) * cos - sq)
  }
  return normalize(
    A * ((A + 1) + (A - 1) * cos + sq),
    -2 * A * ((A - 1) + (A + 1) * cos),
    A * ((A + 1) + (A - 1) * cos - sq),
    (A + 1) - (A - 1) * cos + sq,
    2 * ((A - 1) - (A + 1) * cos),
    (A + 1) - (A - 1) * cos - sq)
}

export const lowShelf = (f, g, s, r) => shelf('low', f, g, s, r)
export const highShelf = (f, g, s, r) => shelf('high', f, g, s, r)

// FFT radix-2 in-place (re/im são Float64Array com tamanho potência de 2).
export function fft (re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// Espectro médio (Welch) com janela de Hann e 50% de sobreposição, como o
// "Plot Spectrum" do Audacity (lib-builtin-effects/PlotSpectrumBase.cpp / FreqWindow.cpp).
export function averageSpectrum (signal, size) {
  const half = size / 2
  const acc = new Float64Array(half)
  const win = new Float64Array(size)
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1))
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let windows = 0
  for (let start = 0; start + size <= signal.length; start += half) {
    for (let i = 0; i < size; i++) { re[i] = signal[start + i] * win[i]; im[i] = 0 }
    fft(re, im)
    for (let k = 0; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k]
    windows++
  }
  // Normaliza pela soma da janela: uma senoide de amplitude A aparece com
  // pico ≈ 20·log10(A) dB (0 dB = senoide em escala cheia).
  const winSum = win.reduce((s, w) => s + w, 0)
  const scale = 4 / (winSum * winSum)
  const db = new Float64Array(half)
  for (let k = 0; k < half; k++) {
    const p = windows ? acc[k] / windows * scale : 0
    db[k] = 10 * Math.log10(p + 1e-20)
  }
  return { db, windows }
}
