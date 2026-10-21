// Cores de faixa. Cada faixa nova recebe a próxima cor da paleta; o usuário
// pode trocar pelo menu da faixa. A cor pinta o cabeçalho, o clip, a onda/notas,
// a coluna da mesa de som e as notas do piano roll.

export const TRACK_COLORS = [
  { name: 'Azul', value: '#3d7bf5' },
  { name: 'Amarelo', value: '#e3b33c' },
  { name: 'Roxo', value: '#8b5cf6' },
  { name: 'Verde', value: '#2fbf8a' },
  { name: 'Ciano', value: '#22b8cf' },
  { name: 'Rosa', value: '#e2558f' },
  { name: 'Laranja', value: '#f0803c' },
  { name: 'Lima', value: '#8bc34a' },
  { name: 'Vermelho', value: '#e5484d' },
  { name: 'Índigo', value: '#5c6bf2' },
  { name: 'Turquesa', value: '#14a39a' },
  { name: 'Magenta', value: '#c04fd8' }
]

let next = 0
export const nextTrackColor = () => TRACK_COLORS[next++ % TRACK_COLORS.length].value

function rgb (hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const rgba = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`

// Mistura com branco (t > 0) ou com preto (t < 0).
export function shade (hex, t) {
  const target = t > 0 ? 255 : 0
  const k = Math.abs(t)
  const [r, g, b] = rgb(hex).map(c => Math.round(c + (target - c) * k))
  return `rgb(${r},${g},${b})`
}

// Texto legível sobre a cor (escuro em cores claras, claro em escuras).
export function textOn (hex) {
  const [r, g, b] = rgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#10131a' : '#ffffff'
}
