// Leitura e escrita de Standard MIDI Files (SMF formatos 0 e 1).
//
// O Audacity importa MIDI pela biblioteca Allegro (lib-src/portsmf, usado por
// modules/track-ui/mod-midi-import-export/ImportMIDI.cpp) e guarda as notas em
// segundos num Alg_seq (lib-note-track/NoteTrack.h). Aqui fazemos o mesmo:
// os ticks são convertidos para segundos com o mapa de andamento do arquivo.

let nextNoteId = 1
export const noteId = () => nextNoteId++

class Reader {
  constructor (buf) { this.v = new DataView(buf); this.p = 0 }
  u8 () { return this.v.getUint8(this.p++) }
  u16 () { const x = this.v.getUint16(this.p); this.p += 2; return x }
  u32 () { const x = this.v.getUint32(this.p); this.p += 4; return x }
  str (n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s }
  vlq () {
    let x = 0
    for (let i = 0; i < 4; i++) {
      const b = this.u8()
      x = (x << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return x
  }
}

function decodeText (bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new TextDecoder('latin1').decode(bytes) }
}

// Converte ticks em segundos usando o mapa de andamento (eventos 0xFF 0x51).
function tickToSeconds (tempos, ppq) {
  const segs = []
  let sec = 0
  let lastTick = 0
  let usPerQ = 500000 // 120 bpm até aparecer um evento de tempo
  for (const t of tempos) {
    sec += (t.tick - lastTick) / ppq * usPerQ / 1e6
    lastTick = t.tick
    usPerQ = t.usPerQ
    segs.push({ tick: t.tick, sec, usPerQ })
  }
  return tick => {
    let s = { tick: 0, sec: 0, usPerQ: 500000 }
    for (const seg of segs) { if (seg.tick <= tick) s = seg; else break }
    return s.sec + (tick - s.tick) / ppq * s.usPerQ / 1e6
  }
}

// Devolve { tempo, tracks: [{ name, channel, program, drum, notes:[{id,pitch,start,dur,vel}] }] }.
// Cada combinação (faixa do arquivo, canal) vira uma faixa separada.
export function parseMidi (buf) {
  const r = new Reader(buf)
  if (r.str(4) !== 'MThd') throw new Error('Arquivo MIDI inválido (cabeçalho MThd ausente).')
  const hlen = r.u32()
  const format = r.u16()
  const ntrks = r.u16()
  const division = r.u16()
  r.p = 8 + hlen
  if (division & 0x8000) throw new Error('Arquivos MIDI com divisão SMPTE não são suportados.')
  if (format > 1) throw new Error(`MIDI formato ${format} não suportado (apenas 0 e 1).`)
  const ppq = division

  const tempos = []
  const raw = []
  for (let n = 0; n < ntrks && r.p < buf.byteLength; n++) {
    const id = r.str(4)
    const len = r.u32()
    const end = r.p + len
    if (id !== 'MTrk') { r.p = end; continue }
    let tick = 0
    let status = 0
    let name = ''
    const events = []
    while (r.p < end) {
      tick += r.vlq()
      let b = r.u8()
      if (b === 0xff) {
        const type = r.u8()
        const l = r.vlq()
        const data = new Uint8Array(buf, r.p, l)
        r.p += l
        if (type === 0x51 && l === 3) tempos.push({ tick, usPerQ: (data[0] << 16) | (data[1] << 8) | data[2] })
        else if ((type === 0x03 || type === 0x04) && !name) name = decodeText(data).trim()
        continue
      }
      if (b === 0xf0 || b === 0xf7) { r.p += r.vlq(); continue }
      if (b & 0x80) { status = b; b = r.u8() } // senão: running status, b já é o 1º dado
      const type = status & 0xf0
      const ch = status & 0x0f
      if (type === 0xc0 || type === 0xd0) { events.push({ tick, type, ch, a: b }); continue }
      const c = r.u8()
      events.push({ tick, type, ch, a: b, b: c })
    }
    r.p = end
    raw.push({ name, events })
  }

  tempos.sort((a, b) => a.tick - b.tick)
  const toSec = tickToSeconds(tempos, ppq)
  const tracks = []
  raw.forEach((t, ti) => {
    const byCh = new Map()
    const get = ch => {
      if (!byCh.has(ch)) byCh.set(ch, { channel: ch, program: 0, notes: [], open: new Map() })
      return byCh.get(ch)
    }
    for (const e of t.events) {
      const c = get(e.ch)
      if (e.type === 0xc0) {
        if (!c.notes.length) c.program = e.a
      } else if (e.type === 0x90 && e.b > 0) {
        const key = e.a
        if (!c.open.has(key)) c.open.set(key, [])
        c.open.get(key).push({ tick: e.tick, vel: e.b })
      } else if (e.type === 0x80 || (e.type === 0x90 && e.b === 0)) {
        const stack = c.open.get(e.a)
        const on = stack?.shift()
        if (on) {
          const start = toSec(on.tick)
          c.notes.push({ id: noteId(), pitch: e.a, start, dur: Math.max(0.005, toSec(e.tick) - start), vel: on.vel })
        }
      }
    }
    for (const c of byCh.values()) {
      if (!c.notes.length) continue
      c.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
      const drum = c.channel === 9
      const base = t.name || `Faixa ${ti + 1}`
      tracks.push({
        name: byCh.size > 1 || drum ? `${base} (canal ${c.channel + 1}${drum ? ', bateria' : ''})` : base,
        channel: c.channel, program: c.program, drum, notes: c.notes
      })
    }
  })
  const tempo = tempos.length ? Math.round(60e6 / tempos[0].usPerQ * 100) / 100 : 120
  return { tempo, tracks }
}

// ---------- Escrita ----------
function vlq (n) {
  const bytes = [n & 0x7f]
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80)
  return bytes
}

// Grava SMF formato 1 (uma faixa por faixa MIDI do projeto). Tempo único.
export function writeMidi (tracks, tempo = 120) {
  const PPQ = 480
  const ticksPerSec = PPQ * tempo / 60
  const chunk = (id, data) => [...id].map(c => c.charCodeAt(0)).concat(
    [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255], data)

  const usPerQ = Math.round(60e6 / tempo)
  const tempoTrack = [0, 0xff, 0x51, 3, (usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255, 0, 0xff, 0x2f, 0]
  const out = [...chunk('MThd', [0, 1, 0, tracks.length + 1, PPQ >> 8, PPQ & 255]), ...chunk('MTrk', tempoTrack)]

  let nextCh = 0
  for (const t of tracks) {
    let ch = t.drum ? 9 : nextCh++
    if (ch === 9 && !t.drum) ch = nextCh++
    ch &= 15
    const name = [...new TextEncoder().encode(t.name)]
    const ev = []
    for (const n of t.notes) {
      const on = Math.round((t.offset + n.start) * ticksPerSec)
      const off = Math.max(on + 1, Math.round((t.offset + n.start + n.dur) * ticksPerSec))
      ev.push({ tick: on, data: [0x90 | ch, n.pitch, Math.max(1, Math.min(127, Math.round(n.vel)))] })
      ev.push({ tick: off, data: [0x80 | ch, n.pitch, 0] })
    }
    // note-off antes de note-on no mesmo tick (evita notas "presas").
    ev.sort((a, b) => a.tick - b.tick || (a.data[0] & 0xf0) - (b.data[0] & 0xf0))
    const data = [0, 0xff, 0x03, ...vlq(name.length), ...name, 0, 0xc0 | ch, t.program & 127]
    let last = 0
    for (const e of ev) { data.push(...vlq(e.tick - last), ...e.data); last = e.tick }
    data.push(0, 0xff, 0x2f, 0)
    out.push(...chunk('MTrk', data))
  }
  return new Blob([new Uint8Array(out)], { type: 'audio/midi' })
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const pitchName = p => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`
export const isBlackKey = p => [1, 3, 6, 8, 10].includes(p % 12)
