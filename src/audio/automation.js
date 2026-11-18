// Automação de volume e pan por faixa (envelopes), como o envelope de clipe do
// Audacity (lib-wave-track Envelope) e as faixas de automação das DAWs.
//
//   track.automation = { gain: [{ t, v }], pan: [{ t, v }] }
//
// `t` em segundos desde o início da faixa (track.offset): mover a faixa leva a
// automação junto. Volume em dB somados ao fader da faixa (0 = sem mudança);
// pan de −1 (esquerda) a 1 (direita), no lugar do pan da faixa. Entre os pontos o
// valor é interpolado em linha reta; antes do primeiro e depois do último, fica
// o valor deles. O motor nativo faz o mesmo em MixGraph::finishTrack.

import { channelVolumes } from './buffer.js'

export const AUTOMATION_PARAMS = {
  gain: { label: 'Volume', min: -36, max: 12, unit: 'dB', neutral: () => 0 },
  pan: { label: 'Pan', min: -1, max: 1, unit: '', neutral: track => track.pan }
}

export const EMPTY_AUTOMATION = Object.freeze({ gain: Object.freeze([]), pan: Object.freeze([]) })

export const hasAutomation = track => !!(track.automation?.gain?.length || track.automation?.pan?.length)

export function envelopeAt (points, t) {
  if (t <= points[0].t) return points[0].v
  const last = points[points.length - 1]
  if (t >= last.t) return last.v
  let i = 1
  while (points[i].t < t) i++
  const a = points[i - 1]
  const b = points[i]
  return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t))
}

// Ganho e pan efetivos da faixa no tempo T do projeto.
export function automationValues (track, T) {
  const { gain = [], pan = [] } = track.automation ?? {}
  const local = T - track.offset
  return {
    gain: track.gain + (gain.length ? envelopeAt(gain, local) : 0),
    pan: pan.length ? Math.max(-1, Math.min(1, envelopeAt(pan, local))) : track.pan
  }
}

// Ganhos L/R da faixa em [from, to] (tempo do projeto) como pontos { T, l, r }
// para rampas lineares de AudioParam. Onde o volume muda, o trecho é amostrado a
// cada 20 ms, porque dB em linha reta não é uma reta no ganho linear.
export function automationRamps (track, from, to, step = 0.02) {
  const { gain = [], pan = [] } = track.automation ?? {}
  const times = new Set([from, to])
  for (const p of [...gain, ...pan]) {
    const T = track.offset + p.t
    if (T > from && T < to) times.add(T)
  }
  const sorted = [...times].sort((a, b) => a - b)
  const at = T => {
    const [l, r] = channelVolumes(automationValues(track, T))
    return { T, l, r }
  }
  const out = [at(sorted[0])]
  const minStep = Math.max(step, (to - from) / 20000) // limite de eventos por faixa
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    const end = at(b)
    const prev = out[out.length - 1]
    if (gain.length && (end.l !== prev.l || end.r !== prev.r)) {
      for (let T = a + minStep; T < b - minStep / 2; T += minStep) out.push(at(T))
    }
    out.push(end)
  }
  return out
}

// ---------- Edição (mantém os pontos alinhados com o áudio da faixa) ----------
const mapLanes = (automation, fn) => (automation
  ? { gain: fn(automation.gain ?? []), pan: fn(automation.pan ?? []) }
  : automation)

// Trecho [a, b) (tempo da faixa) removido: o que vinha depois anda para trás.
export const removeAutomationRange = (automation, a, b) => mapLanes(automation, points => points
  .filter(p => p.t < a || p.t >= b)
  .map(p => (p.t >= b ? { ...p, t: p.t - (b - a) } : p)))

// Trecho de `duration` inserido em `at` (tempo da faixa): o que vinha depois anda para frente.
export const insertAutomationGap = (automation, at, duration) => mapLanes(automation, points =>
  points.map(p => (p.t >= at ? { ...p, t: p.t + duration } : p)))

// Só [a, b) fica; o tempo passa a contar de `a`.
export const trimAutomation = (automation, a, b) => mapLanes(automation, points => points
  .filter(p => p.t >= a && p.t <= b)
  .map(p => ({ ...p, t: p.t - a })))

// Todos os pontos deslocados (a faixa ganhou silêncio no começo, por exemplo).
export const shiftAutomation = (automation, delta) => mapLanes(automation, points =>
  points.map(p => ({ ...p, t: p.t + delta })))
