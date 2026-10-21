// Formatação de tempo "hh:mm:ss.mmm", como o formato padrão da Selection Toolbar
// (lib-numeric-formats, "hh:mm:ss + milliseconds").

export function formatTime (t, withMs = true) {
  if (t === null || t === undefined || !isFinite(t)) t = 0
  const neg = t < 0
  t = Math.abs(t)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.floor((t * 1000) % 1000)
  const pad = (v, n = 2) => String(v).padStart(n, '0')
  return `${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}${withMs ? '.' + pad(ms, 3) : ''}`
}

// Aceita "hh:mm:ss.mmm", "mm:ss", "ss.mmm" ou número de segundos.
export function parseTime (text) {
  const parts = String(text).trim().replace(',', '.').split(':').map(Number)
  if (parts.some(p => Number.isNaN(p))) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

// Rótulos compactos da régua.
export function formatRuler (t, step) {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
  const sec = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')
  if (t >= 3600) return `${Math.floor(t / 3600)}:${String(m % 60).padStart(2, '0')}:${sec}`
  return m ? `${m}:${sec}` : `${s.toFixed(decimals)}`
}
