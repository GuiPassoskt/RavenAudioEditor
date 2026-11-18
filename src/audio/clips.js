// Clips das faixas de áudio, como os WaveClip do Audacity (lib-wave-track).
//
// O áudio da faixa continua num buffer só (track.channels, a partir de
// track.offset); os clips são regiões dele, em amostras: [{ s0, s1 }], em ordem e
// sem sobreposição. Fora dos clips o buffer é silêncio, por isso os motores de
// áudio, a exportação e o congelamento não precisam saber de clips. Dois clips
// podem encostar um no outro (depois de "Dividir clipe").
//
// As funções daqui são puras: recebem a lista e devolvem uma nova (o histórico de
// desfazer guarda as listas antigas).

export const wholeClips = length => (length > 0 ? [{ s0: 0, s1: length }] : [])

// Em ordem, dentro de [0, length], sem clips vazios; os que se sobrepõem viram um.
export function normalizeClips (clips, length) {
  const sorted = clips
    .map(c => ({ s0: Math.max(0, Math.min(length, c.s0)), s1: Math.max(0, Math.min(length, c.s1)) }))
    .filter(c => c.s1 > c.s0)
    .sort((a, b) => a.s0 - b.s0)
  const out = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.s0 < last.s1) last.s1 = Math.max(last.s1, c.s1)
    else out.push({ ...c })
  }
  return out
}

// [s0, s1) apagado e o resto puxado para a esquerda (Excluir, Recortar).
export function removeClipRange (clips, s0, s1) {
  const d = s1 - s0
  const f = x => (x <= s0 ? x : x >= s1 ? x - d : s0)
  return clips.map(c => ({ s0: f(c.s0), s1: f(c.s1) })).filter(c => c.s1 > c.s0)
}

// n amostras inseridas em s (Colar, Gerar). Dentro de um clip, ele cresce; num vão
// ou fora da faixa, vira um clip novo.
export function insertClipRange (clips, s, n) {
  const inside = clips.findIndex(c => c.s0 < s && s < c.s1)
  // Um clip que termina em s fica onde está; um que começa em s anda.
  const out = clips.map((c, i) => (i === inside
    ? { s0: c.s0, s1: c.s1 + n }
    : { s0: c.s0 >= s ? c.s0 + n : c.s0, s1: c.s1 > s ? c.s1 + n : c.s1 }))
  if (inside < 0) out.push({ s0: s, s1: s + n })
  return out.sort((a, b) => a.s0 - b.s0)
}

// [s0, s1) trocado por n amostras (efeito que muda a duração). Os clips que
// encostam no trecho processado viram um só com ele: o resultado pode ter som
// onde antes era vão (a cauda de um eco, por exemplo).
export function replaceClipRange (clips, s0, s1, n) {
  const d = n - (s1 - s0)
  const f = x => (x <= s0 ? x : x >= s1 ? x + d : s0 + Math.round(((x - s0) * n) / (s1 - s0)))
  const mapped = clips.map(c => ({ s0: f(c.s0), s1: f(c.s1) })).filter(c => c.s1 > c.s0)
  const touching = mapped.filter(c => c.s1 > s0 && c.s0 < s0 + n)
  if (!touching.length) return mapped
  const merged = { s0: Math.min(s0, ...touching.map(c => c.s0)), s1: Math.max(s0 + n, ...touching.map(c => c.s1)) }
  return [...mapped.filter(c => !touching.includes(c)), merged].sort((a, b) => a.s0 - b.s0)
}

// Só [s0, s1) fica, e passa a começar em 0 (Aparar).
export const trimClips = (clips, s0, s1) => clips
  .map(c => ({ s0: Math.max(c.s0, s0) - s0, s1: Math.min(c.s1, s1) - s0 }))
  .filter(c => c.s1 > c.s0)

export const shiftClips = (clips, d) => clips.map(c => ({ s0: c.s0 + d, s1: c.s1 + d }))

export const scaleClips = (clips, factor) => clips.map(c => ({ s0: Math.round(c.s0 * factor), s1: Math.round(c.s1 * factor) }))

// Áudio novo escrito em [s0, s1) por cima (gravação): um clip com os que ele toca.
export function addClip (clips, s0, s1) {
  const touching = clips.filter(c => c.s1 > s0 && c.s0 < s1)
  const merged = { s0: Math.min(s0, ...touching.map(c => c.s0)), s1: Math.max(s1, ...touching.map(c => c.s1)) }
  return [...clips.filter(c => !touching.includes(c)), merged].sort((a, b) => a.s0 - b.s0)
}

// Divide os clips nas posições dadas (Dividir clipe).
export function splitClips (clips, positions) {
  let out = clips
  for (const s of positions) {
    out = out.flatMap(c => (c.s0 < s && s < c.s1 ? [{ s0: c.s0, s1: s }, { s0: s, s1: c.s1 }] : [c]))
  }
  return out
}

// Os clips que tocam [s0, s1] viram um só, do primeiro ao último (Juntar clipes).
export function joinClips (clips, s0, s1) {
  const touching = clips.filter(c => c.s1 >= s0 && c.s0 <= s1)
  if (touching.length < 2) return clips
  const merged = { s0: Math.min(...touching.map(c => c.s0)), s1: Math.max(...touching.map(c => c.s1)) }
  return [...clips.filter(c => !touching.includes(c)), merged].sort((a, b) => a.s0 - b.s0)
}

// [s0, s1) vira vão, sem puxar o resto (Dividir e excluir).
export const clearClipRange = (clips, s0, s1) => clips.flatMap(c => {
  if (c.s1 <= s0 || c.s0 >= s1) return [c]
  return [{ s0: c.s0, s1: Math.min(c.s1, s0) }, { s0: Math.max(c.s0, s1), s1: c.s1 }].filter(x => x.s1 > x.s0)
})

// Índice do clip em `s` (amostra do buffer), ou -1 num vão.
export const clipAt = (clips, s) => clips.findIndex(c => c.s0 <= s && s < c.s1)
