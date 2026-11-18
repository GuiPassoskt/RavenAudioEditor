// Exportação WAV e formato de projeto próprio (.ravenproj; .reaproj antigos também abrem).
//
// O Audacity salva projetos .aup3 em SQLite (lib-project-file-io/ProjectFileIO.cpp,
// tabelas "project" e "sampleblocks"). No navegador usamos um contêiner binário
// simples: cabeçalho JSON (inclui notas MIDI e efeitos) + amostras Float32 em sequência.

import { noteId } from './midifile.js'

export function encodeWav (channels, rate, format = 'pcm16') {
  const n = channels.length
  const len = channels[0]?.length ?? 0
  const bytes = format === 'float32' ? 4 : 2
  const dataSize = len * n * bytes
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, format === 'float32' ? 3 : 1, true)
  v.setUint16(22, n, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * n * bytes, true)
  v.setUint16(32, n * bytes, true)
  v.setUint16(34, bytes * 8, true)
  str(36, 'data'); v.setUint32(40, dataSize, true)
  let o = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < n; c++) {
      const s = channels[c][i]
      if (format === 'float32') {
        v.setFloat32(o, s, true)
      } else {
        const x = Math.max(-1, Math.min(1, s))
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true)
      }
      o += bytes
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

const MAGIC = 'REAP' // assinatura mantida para abrir projetos antigos

// Efeito em tempo real no arquivo: embutido (parâmetros) ou plugin (identificação e estado).
const effectJson = ({ type, params, enabled, plugin, state }) =>
  type === 'plugin' ? { type, enabled, plugin, state } : { type, params, enabled }

// Envios guardam a posição do barramento na lista (os ids mudam ao abrir); a
// faixa congelada é salva sem o áudio pré-renderizado (congela de novo se precisar).
export function encodeProject (project) {
  const index = new Map(project.tracks.map((t, i) => [t.id, i]))
  const mixing = t => ({
    sends: (t.sends ?? []).map(s => ({ bus: index.get(s.bus), level: s.level })),
    automation: { gain: t.automation?.gain ?? [], pan: t.automation?.pan ?? [] }
  })
  const header = {
    version: 1,
    name: project.name,
    rate: project.rate,
    tempo: project.tempo ?? 120,
    tracks: project.tracks.map(t => t.kind === 'bus'
      ? {
          kind: 'bus', name: t.name, color: t.color, offset: 0, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo,
          channels: 0, length: 0, effects: (t.effects ?? []).map(effectJson), automation: mixing(t).automation
        }
      : t.kind === 'midi'
      ? {
          kind: 'midi', name: t.name, color: t.color, offset: t.offset, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo,
          program: t.program, drum: t.drum, channels: 0, length: 0,
          instrument: t.instrument ? { plugin: t.instrument.plugin, state: t.instrument.state } : null,
          effects: (t.effects ?? []).map(effectJson),
          notes: t.notes.map(({ pitch, start, dur, vel }) => ({ pitch, start, dur, vel })),
          ...mixing(t)
        }
      : {
          name: t.name, color: t.color, offset: t.offset, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo,
          effects: (t.effects ?? []).map(effectJson),
          channels: t.channels.length, length: t.channels[0].length,
          clips: (t.clips ?? []).map(c => [c.s0, c.s1]),
          ...mixing(t)
        }),
    master: {
      gain: project.master?.gain ?? 0,
      effects: (project.master?.effects ?? []).map(effectJson)
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  // Completa o JSON com espaços para os Float32 começarem alinhados em 4 bytes.
  const pad = (4 - ((8 + json.length) % 4)) % 4
  const parts = [MAGIC, new Uint32Array([json.length + pad]), json, new Uint8Array(pad).fill(32)]
  for (const t of project.tracks) for (const ch of t.channels ?? []) parts.push(ch)
  return new Blob(parts, { type: 'application/octet-stream' })
}

export async function decodeProject (blob) {
  const buf = await blob.arrayBuffer()
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4))
  if (magic !== MAGIC) throw new Error('Arquivo não é um projeto do Raven Audio Editor válido')
  const jsonLen = new DataView(buf).getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jsonLen)))
  let pos = 8 + jsonLen
  const tracks = header.tracks.map(t => {
    const channels = []
    for (let c = 0; c < t.channels; c++) {
      channels.push(new Float32Array(buf.slice(pos, pos + t.length * 4)))
      pos += t.length * 4
    }
    if (t.kind === 'midi') return { ...t, channels: [], notes: t.notes.map(n => ({ ...n, id: noteId() })) }
    if (t.kind === 'bus') return { ...t, channels: [] }
    // Sem clips (projeto de antes deles): o buffer inteiro é um clip.
    return { ...t, channels, clips: t.clips?.map(([s0, s1]) => ({ s0, s1 })) }
  })
  return { name: header.name, rate: header.rate, tempo: header.tempo, tracks, master: header.master }
}

export function download (blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function pickFiles (accept, multiple = true) {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve([...input.files])
    input.click()
  })
}
