// Estado do projeto: faixas, seleção, zoom, histórico, transporte e gravação.
//
// Correspondência com o Audacity:
//   tracks / Track          -> lib-track (TrackList) + lib-wave-track (WaveTrack)
//   sel                     -> lib-time-frequency-selection (SelectedRegion / ViewInfo)
//   history / pushState     -> lib-project-history (UndoManager::PushState / Undo / Redo)
//   clipboard               -> src/Clipboard.cpp
//   play / pause / record   -> src/ProjectAudioManager.cpp + lib-audio-io (AudioIO)
//   track.effects / master  -> lib-realtime-effects (RealtimeEffectList por faixa e do projeto)
//   kind: 'midi' + notes    -> lib-note-track (NoteTrack sobre Alg_seq do Allegro)

import { defineStore } from 'pinia'
import { markRaw, toRaw } from 'vue'
import {
  DEFAULT_RATE, clampInt, concat, decodeFile, fitChannels, insertAt,
  mixdown, removeRange, replaceRange, resampleLinear
} from 'src/audio/buffer'
import { engine, trackDuration } from 'src/audio/engine'
import { decodeProject, download, encodeProject, encodeWav } from 'src/audio/fileio'
import { parseMidi, writeMidi } from 'src/audio/midifile'
import * as N from 'src/audio/notes'
import { realtimeDef, realtimeDefaults } from 'src/audio/realtime'
import { nextTrackColor } from 'src/audio/colors'

const HISTORY_LIMIT = 200
let nextId = 1
let version = 1
let clipboard = null
let rafId = 0
let rec = null
let nextFxUid = 1

const zeros = n => new Float32Array(Math.max(0, n))
export const isMidi = t => t.kind === 'midi'
const isAudio = t => t.kind !== 'midi'

function makeTrack (props) {
  const midi = props.kind === 'midi'
  return {
    id: nextId++,
    kind: midi ? 'midi' : 'audio',
    name: props.name ?? (midi ? 'Faixa MIDI' : 'Faixa de áudio'),
    color: props.color ?? nextTrackColor(),
    channels: markRaw(midi ? [] : props.channels),
    notes: markRaw(midi ? N.sortNotes([...(props.notes ?? [])]) : []),
    length: midi ? N.notesEnd(props.notes ?? []) : 0,
    program: props.program ?? 0,
    drum: props.drum ?? false,
    offset: props.offset ?? 0,
    gain: props.gain ?? 0,
    pan: props.pan ?? 0,
    mute: props.mute ?? false,
    solo: props.solo ?? false,
    selected: props.selected ?? false,
    effects: (props.effects ?? []).map(newEffectState),
    collapsed: false,
    version: version++
  }
}

// Estado de um efeito em tempo real (RealtimeEffectState). Imutável: toda
// alteração cria um objeto novo, para o histórico de undo continuar válido.
function newEffectState ({ type, params, enabled = true }) {
  return { uid: nextFxUid++, type, enabled, params: { ...realtimeDefaults(type), ...params } }
}

function setChannels (track, channels) {
  track.channels = markRaw(channels)
  track.version = version++
}

function setNotes (track, notes) {
  track.notes = markRaw(N.sortNotes([...notes]))
  track.length = N.notesEnd(track.notes)
  track.version = version++
}

export const useProjectStore = defineStore('project', {
  state: () => ({
    name: 'Sem título',
    rate: DEFAULT_RATE,
    tracks: [],
    master: { gain: 0, effects: [] },
    tempo: 120, // BPM: grade do piano roll e exportação MIDI
    sel: { t0: 0, t1: 0 },
    pps: 100,
    scrollTime: 0,
    viewWidth: 800,
    tool: 'select',
    playhead: null,
    playing: false,
    paused: false,
    pausedAt: null,
    playRange: { t0: 0, t1: 0, isSelection: false },
    loop: false,
    recording: false,
    recTake: null, // { ids, t0, length } da gravação em curso (para o desenho ao vivo)
    levels: { play: [0, 0], rec: 0 },
    history: [],
    historyIndex: -1,
    savedIndex: 0,
    hasClipboard: false,
    busy: false
  }),

  getters: {
    duration: s => s.tracks.reduce((m, t) => Math.max(m, t.offset + trackDuration(t, s.rate)), 0),
    midiTracks: s => s.tracks.filter(isMidi),
    selectedTracks: s => s.tracks.filter(t => t.selected),
    hasSelection: s => s.sel.t1 - s.sel.t0 > 1e-9,
    canUndo: s => s.historyIndex > 0,
    canRedo: s => s.historyIndex < s.history.length - 1,
    dirty: s => s.historyIndex !== s.savedIndex,
    hasRealtime: s => s.master.gain !== 0 || s.master.effects.some(e => e.enabled) ||
      s.tracks.some(t => t.effects.some(e => e.enabled)),
    viewSeconds: s => s.viewWidth / s.pps
  },

  actions: {
    // ---------- Utilidades de tempo ----------
    toSample (track, t) { return Math.round((t - track.offset) * this.rate) },
    trackEnd (track) { return track.offset + trackDuration(track, this.rate) },
    clampedRange (track, t0, t1) {
      const len = track.channels[0].length
      return [clampInt(this.toSample(track, t0), 0, len), clampInt(this.toSample(track, t1), 0, len)]
    },
    findTrack (id) { return this.tracks.find(t => t.id === id) },

    // Extrai [t0, t1) como um clip { kind, channels | notes }. No áudio, o que
    // estiver fora da faixa vira silêncio; no MIDI, as notas são recortadas.
    extract (track, t0, t1) {
      if (isMidi(track)) {
        const notes = N.clipNotes(track.notes, t0 - track.offset, t1 - track.offset)
        return { kind: 'midi', notes, program: track.program, drum: track.drum, duration: t1 - t0 }
      }
      return { kind: 'audio', channels: this.extractChannels(track, t0, t1), duration: t1 - t0 }
    },

    extractChannels (track, t0, t1) {
      const n = Math.round((t1 - t0) * this.rate)
      const start = this.toSample(track, t0)
      return track.channels.map(ch => {
        const out = zeros(n)
        const a = Math.max(0, start)
        const b = Math.min(ch.length, start + n)
        if (b > a) out.set(ch.subarray(a, b), a - start)
        return out
      })
    },

    // Remove [t0, t1) e puxa o restante para a esquerda (como WaveTrack::Clear).
    deleteRange (track, t0, t1) {
      if (isMidi(track)) {
        const a = Math.max(0, t0 - track.offset)
        const b = Math.max(0, t1 - track.offset)
        if (b > a) setNotes(track, N.removeRange(track.notes, a, b))
      } else {
        const [s0, s1] = this.clampedRange(track, t0, t1)
        if (s1 > s0) setChannels(track, track.channels.map(ch => removeRange(ch, s0, s1)))
      }
      if (t1 <= track.offset) track.offset -= (t1 - t0)
      else if (t0 < track.offset) track.offset = t0
      track.offset = Math.max(0, track.offset)
    },

    // Insere canais em t (como WaveTrack::Paste), completando com silêncio se preciso.
    insertAtTime (track, t, clip) {
      if (isMidi(track)) {
        let local = t - track.offset
        let notes = track.notes
        if (!notes.length) { track.offset = t; local = 0 } else if (local < 0) {
          notes = notes.map(n => ({ ...n, start: n.start - local }))
          track.offset = t
          local = 0
        }
        setNotes(track, N.insertNotes(notes, local, clip.notes, clip.duration))
        return
      }
      const data = fitChannels(clip.channels, track.channels.length)
      let s = this.toSample(track, t)
      let channels = track.channels
      if (s < 0) {
        channels = channels.map(ch => concat([zeros(-s), ch]))
        track.offset = t
        s = 0
      }
      if (channels[0].length === 0) {
        track.offset = t
        s = 0
      }
      setChannels(track, channels.map((ch, c) => insertAt(ch, s, data[c])))
    },

    silenceRange (track, t0, t1) {
      if (isMidi(track)) {
        setNotes(track, N.removeRange(track.notes, t0 - track.offset, t1 - track.offset, false))
        return
      }
      const [s0, s1] = this.clampedRange(track, t0, t1)
      if (s1 > s0) setChannels(track, track.channels.map(ch => replaceRange(ch, s0, s1, zeros(s1 - s0))))
    },

    trimRange (track, t0, t1) {
      if (isMidi(track)) {
        const a = Math.max(0, t0 - track.offset)
        setNotes(track, N.clipNotes(track.notes, a, Math.max(a, t1 - track.offset)))
        track.offset += a
        return
      }
      const [s0, s1] = this.clampedRange(track, t0, t1)
      track.offset += s0 / this.rate
      setChannels(track, track.channels.map(ch => ch.slice(s0, s1)))
    },

    regionOf (track) {
      return this.hasSelection ? this.clampedRange(track, this.sel.t0, this.sel.t1) : [0, track.channels[0].length]
    },

    regionChannels (track) {
      const [s0, s1] = this.regionOf(track)
      return track.channels.map(ch => ch.slice(s0, s1))
    },

    // ---------- Histórico (UndoManager) ----------
    snapshot () {
      return {
        tracks: this.tracks.map(t => ({ ...toRaw(t) })),
        master: { ...toRaw(this.master) },
        tempo: this.tempo,
        sel: { ...this.sel }
      }
    },

    restore (state) {
      this.tracks = state.tracks.map(t => ({ ...t, channels: markRaw(t.channels), notes: markRaw(t.notes), version: version++ }))
      this.master = { ...state.master }
      this.tempo = state.tempo ?? this.tempo
      this.sel = { ...state.sel }
    },

    // consolidate = true substitui o último estado se tiver a mesma descrição
    // (equivale a UndoPush::CONSOLIDATE, usado por sliders de ganho/pan).
    pushState (desc, consolidate = false) {
      const entry = { desc, time: new Date(), state: this.snapshot() }
      const last = this.history[this.historyIndex]
      if (consolidate && last && last.desc === desc && this.historyIndex > 0) {
        this.history.splice(this.historyIndex, 1, markRaw(entry))
        return
      }
      this.history.splice(this.historyIndex + 1) // AbandonRedo
      this.history.push(markRaw(entry))
      if (this.history.length > HISTORY_LIMIT) {
        this.history.shift()
        this.savedIndex--
      }
      this.historyIndex = this.history.length - 1
    },

    undo () { if (this.canUndo) this.goToState(this.historyIndex - 1) },
    redo () { if (this.canRedo) this.goToState(this.historyIndex + 1) },
    goToState (i) {
      this.stop()
      this.historyIndex = i
      this.restore(this.history[i].state)
    },

    // ---------- Projeto ----------
    resetProject () {
      this.stop()
      this.name = 'Sem título'
      this.tracks = []
      this.master = { gain: 0, effects: [] }
      this.tempo = 120
      this.sel = { t0: 0, t1: 0 }
      this.scrollTime = 0
      this.pps = 100
      this.history = []
      this.historyIndex = -1
      this.pushState('Projeto criado')
      this.savedIndex = 0
    },

    addTrack (props) {
      const track = makeTrack(props)
      this.tracks.push(track)
      return this.tracks[this.tracks.length - 1]
    },

    newTrack (channels = 1) {
      this.tracks.forEach(t => { t.selected = false })
      this.addTrack({ name: channels === 2 ? 'Faixa estéreo' : 'Faixa mono', channels: Array.from({ length: channels }, () => zeros(0)), selected: true })
      this.pushState(channels === 2 ? 'Nova faixa estéreo' : 'Nova faixa mono')
    },

    async importFiles (files) {
      const imported = []
      this.busy = true
      try {
        for (const file of files) {
          const name = file.name.replace(/\.[^.]+$/, '')
          if (/\.(mid|midi|kar|smf)$/i.test(file.name)) {
            const midi = parseMidi(await file.arrayBuffer())
            if (!midi.tracks.length) throw new Error(`"${file.name}" não contém notas.`)
            if (!this.midiTracks.length) this.tempo = midi.tempo
            for (const t of midi.tracks) this.addTrack({ kind: 'midi', ...t, name: midi.tracks.length > 1 ? `${name} · ${t.name}` : name })
          } else {
            const channels = await decodeFile(await file.arrayBuffer(), this.rate)
            this.addTrack({ name, channels: channels.slice(0, 2) })
          }
          imported.push(name)
        }
      } finally {
        this.busy = false
      }
      if (imported.length) {
        if (this.name === 'Sem título') this.name = imported[0]
        this.pushState(`Importado "${imported.join('", "')}"`)
        if (this.tracks.length === imported.length) this.zoomFit()
      }
      return imported
    },

    async setRate (rate) {
      if (rate === this.rate) return
      const factor = this.rate / rate
      this.stop()
      for (const t of this.tracks.filter(isAudio)) setChannels(t, t.channels.map(ch => resampleLinear(ch, factor)))
      this.rate = rate
      this.pushState(`Taxa do projeto alterada para ${rate} Hz`)
    },

    saveProject () {
      download(encodeProject(this), `${this.name}.ravenproj`)
      this.savedIndex = this.historyIndex
    },

    async openProject (file) {
      const p = await decodeProject(file)
      this.resetProject()
      this.name = p.name
      this.rate = p.rate
      this.tempo = p.tempo ?? 120
      for (const t of p.tracks) this.addTrack(t)
      if (p.master) this.master = { gain: p.master.gain ?? 0, effects: (p.master.effects ?? []).map(newEffectState) }
      this.history = []
      this.historyIndex = -1
      this.pushState('Projeto aberto')
      this.savedIndex = 0
      this.zoomFit()
    },

    async exportWav ({ scope = 'all', format = 'pcm16' } = {}) {
      const anySolo = this.tracks.some(t => t.solo)
      let tracks = this.tracks.filter(t => !t.mute && (!anySolo || t.solo))
      if (scope === 'selection') tracks = tracks.filter(t => t.selected)
      if (!tracks.length) throw new Error('Não há faixas audíveis para exportar.')
      const [t0, t1] = scope === 'selection' && this.hasSelection
        ? [this.sel.t0, this.sel.t1]
        : [0, Math.max(...tracks.map(t => this.trackEnd(t)))]
      // Com efeitos em tempo real ou MIDI a mixagem passa pelo mesmo grafo da
      // reprodução (como o Mixer do Audacity aplica os EffectStage na exportação).
      const useGraph = this.hasRealtime || tracks.some(isMidi)
      const stereo = useGraph || tracks.some(t => t.channels.length > 1 || t.pan !== 0)
      const mix = useGraph
        ? await engine.render({ tracks, rate: this.rate, t0, t1, master: this.master, channels: stereo ? 2 : 1 })
        : mixdown(tracks, this.rate, t0, t1, stereo ? 2 : 1)
      const suffix = scope === 'selection' ? '-selecao' : ''
      download(encodeWav(mix, this.rate, format), `${this.name}${suffix}.wav`)
    },

    // ---------- Seleção ----------
    setSelection (t0, t1) {
      if (t1 < t0) [t0, t1] = [t1, t0]
      this.sel = { t0: Math.max(0, t0), t1: Math.max(0, t1) }
    },
    selectAll () {
      this.tracks.forEach(t => { t.selected = true })
      this.setSelection(0, this.duration)
    },
    selectNone () {
      this.tracks.forEach(t => { t.selected = false })
      this.setSelection(this.sel.t0, this.sel.t0)
    },
    selectAllTracks () { this.tracks.forEach(t => { t.selected = true }) },
    selectStartToCursor () { this.setSelection(0, this.sel.t0) },
    selectCursorToEnd () { this.setSelection(this.sel.t0, this.duration) },
    selectTrack (id, additive = false) {
      for (const t of this.tracks) {
        if (t.id === id) t.selected = additive ? !t.selected : true
        else if (!additive) t.selected = false
      }
    },
    cursorTo (t) {
      this.setSelection(t, t)
      this.ensureVisible(t)
    },

    // ---------- Edição ----------
    requireTargets () {
      const targets = this.selectedTracks
      if (!targets.length) throw new Error('Selecione uma ou mais faixas primeiro.')
      return targets
    },

    requireTimeSelection () {
      if (!this.hasSelection) throw new Error('Selecione um trecho de áudio primeiro.')
    },

    copy () {
      this.requireTimeSelection()
      const targets = this.requireTargets()
      clipboard = {
        duration: this.sel.t1 - this.sel.t0,
        tracks: targets.map(t => ({ name: t.name, clip: this.extract(t, this.sel.t0, this.sel.t1) }))
      }
      this.hasClipboard = true
    },

    cut () {
      this.copy()
      for (const t of this.selectedTracks) this.deleteRange(t, this.sel.t0, this.sel.t1)
      this.setSelection(this.sel.t0, this.sel.t0)
      this.pushState('Recortar')
    },

    remove () {
      this.requireTimeSelection()
      for (const t of this.requireTargets()) this.deleteRange(t, this.sel.t0, this.sel.t1)
      this.setSelection(this.sel.t0, this.sel.t0)
      this.pushState('Excluir')
    },

    paste () {
      if (!clipboard) throw new Error('A área de transferência está vazia.')
      const { t0, t1 } = this.sel
      const targets = this.selectedTracks
      clipboard.tracks.forEach(({ name, clip }, i) => {
        const target = targets[i]
        // Sem faixa de destino, ou de outro tipo (áudio x MIDI): cria uma faixa nova.
        if (!target || (target.kind ?? 'audio') !== clip.kind) {
          this.addTrack({ ...clip, name, offset: t0, selected: true })
          return
        }
        if (t1 > t0) this.deleteRange(target, t0, t1)
        this.insertAtTime(target, t0, clip)
      })
      this.setSelection(t0, t0 + clipboard.duration)
      this.pushState('Colar')
    },

    duplicate () {
      const targets = this.requireTargets()
      for (const t of targets) {
        t.selected = false
        const [clip, offset] = this.hasSelection
          ? [this.extract(t, this.sel.t0, this.sel.t1), this.sel.t0]
          : [{ kind: t.kind, channels: t.channels, notes: t.notes, program: t.program, drum: t.drum }, t.offset]
        this.addTrack({ ...clip, name: `${t.name} (cópia)`, offset, gain: t.gain, pan: t.pan, color: t.color, selected: true })
      }
      this.pushState('Duplicar')
    },

    silence () {
      this.requireTimeSelection()
      for (const t of this.requireTargets()) this.silenceRange(t, this.sel.t0, this.sel.t1)
      this.pushState('Silenciar áudio')
    },

    trim () {
      this.requireTimeSelection()
      for (const t of this.requireTargets()) this.trimRange(t, this.sel.t0, this.sel.t1)
      this.pushState('Aparar áudio')
    },

    // "Split New": move a seleção para uma nova faixa, deixando um vão no original.
    splitNew () {
      this.requireTimeSelection()
      for (const t of this.requireTargets()) {
        const clip = this.extract(t, this.sel.t0, this.sel.t1)
        this.silenceRange(t, this.sel.t0, this.sel.t1)
        t.selected = false
        this.addTrack({ ...clip, name: `${t.name} (dividida)`, offset: this.sel.t0, color: t.color, selected: true })
      }
      this.pushState('Dividir em nova faixa')
    },

    // ---------- Faixas ----------
    removeTrack (id) {
      const t = this.findTrack(id)
      this.tracks = this.tracks.filter(x => x.id !== id)
      this.pushState(`Removida a faixa "${t?.name}"`)
    },
    removeSelectedTracks () {
      this.requireTargets()
      this.tracks = this.tracks.filter(t => !t.selected)
      this.pushState('Faixas removidas')
    },
    moveTrack (id, dir) {
      const i = this.tracks.findIndex(t => t.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= this.tracks.length) return
      const list = [...this.tracks];
      [list[i], list[j]] = [list[j], list[i]]
      this.tracks = list
      this.pushState(dir < 0 ? 'Faixa movida para cima' : 'Faixa movida para baixo')
    },
    setTrackProp (id, key, value) {
      const t = this.findTrack(id)
      if (!t) return
      t[key] = value
      this.syncPlayback()
      const labels = { gain: 'Ganho alterado', pan: 'Pan alterado', mute: 'Mudo alternado', solo: 'Solo alternado', name: 'Faixa renomeada', color: 'Cor da faixa alterada', offset: 'Faixa movida' }
      if (labels[key]) this.pushState(labels[key], ['gain', 'pan'].includes(key))
    },
    makeStereoToMono () {
      for (const t of this.requireTargets().filter(isAudio)) if (t.channels.length > 1) setChannels(t, fitChannels(t.channels, 1))
      this.pushState('Estéreo para mono')
    },
    // "Mix and Render": substitui as faixas selecionadas por uma única mixagem.
    // Os efeitos em tempo real das faixas são aplicados; os do master, não.
    async mixAndRender () {
      const targets = this.requireTargets()
      const t0 = Math.min(...targets.map(t => t.offset))
      const t1 = Math.max(...targets.map(t => this.trackEnd(t)))
      const withFx = targets.some(t => isMidi(t) || t.effects.some(e => e.enabled))
      const stereo = withFx || targets.some(t => t.channels.length > 1 || t.pan !== 0)
      const channels = withFx
        ? await engine.render({ tracks: targets, rate: this.rate, t0, t1, master: this.master, applyMaster: false, channels: stereo ? 2 : 1 })
        : mixdown(targets, this.rate, t0, t1, stereo ? 2 : 1)
      const index = this.tracks.indexOf(targets[0])
      const mixed = makeTrack({ name: 'Mixagem', channels, offset: t0, selected: true })
      this.tracks = this.tracks.filter(t => !t.selected)
      this.tracks.splice(Math.min(index, this.tracks.length), 0, mixed)
      this.pushState('Mixar e renderizar')
    },

    // ---------- Efeitos em tempo real (por faixa e master) ----------
    fxTarget (target) {
      const obj = target === 'master' ? this.master : this.findTrack(target)
      if (!obj) throw new Error('Faixa não encontrada.')
      return obj
    },
    fxTargetName (target) { return target === 'master' ? 'Master' : this.fxTarget(target).name },

    addRealtimeEffect (target, type) {
      const obj = this.fxTarget(target)
      obj.effects = [...obj.effects, newEffectState({ type })]
      this.pushState(`Adicionado ${realtimeDef(type).name} em "${this.fxTargetName(target)}"`)
      this.syncPlayback()
    },
    removeRealtimeEffect (target, uid) {
      const obj = this.fxTarget(target)
      const fx = obj.effects.find(e => e.uid === uid)
      obj.effects = obj.effects.filter(e => e.uid !== uid)
      this.pushState(`Removido ${realtimeDef(fx.type).name} de "${this.fxTargetName(target)}"`)
      this.syncPlayback()
    },
    moveRealtimeEffect (target, uid, dir) {
      const obj = this.fxTarget(target)
      const i = obj.effects.findIndex(e => e.uid === uid)
      const j = i + dir
      if (i < 0 || j < 0 || j >= obj.effects.length) return
      const list = [...obj.effects];
      [list[i], list[j]] = [list[j], list[i]]
      obj.effects = list
      this.pushState('Efeito reordenado')
      this.syncPlayback()
    },
    toggleRealtimeEffect (target, uid) {
      const obj = this.fxTarget(target)
      obj.effects = obj.effects.map(e => (e.uid === uid ? { ...e, enabled: !e.enabled } : e))
      this.pushState('Efeito ligado/desligado')
      this.syncPlayback()
    },
    setRealtimeParam (target, uid, key, value) {
      const obj = this.fxTarget(target)
      obj.effects = obj.effects.map(e => (e.uid === uid ? { ...e, params: { ...e.params, [key]: value } } : e))
      this.pushState('Parâmetro de efeito alterado', true)
      this.syncPlayback()
    },
    setMasterGain (value) {
      this.master = { ...this.master, gain: value }
      this.pushState('Volume master alterado', true)
      this.syncPlayback()
    },

    // "Aplicar" a cadeia da faixa: grava o resultado no áudio e esvazia a cadeia.
    async renderTrackEffects (id) {
      const t = this.fxTarget(id)
      if (isMidi(t)) return this.renderMidiToAudio(id)
      if (!t.effects.length) throw new Error('A faixa não tem efeitos.')
      const dry = { ...toRaw(t), gain: 0, pan: 0, mute: false, solo: false }
      const channels = await engine.render({
        tracks: [dry], rate: this.rate, t0: t.offset, t1: this.trackEnd(t),
        master: this.master, applyMaster: false, channels: t.channels.length
      })
      setChannels(t, channels)
      t.effects = []
      this.pushState(`Efeitos aplicados em "${t.name}"`)
    },

    // Repassa mudanças de mix/efeitos para a reprodução em curso. Se a estrutura
    // de alguma cadeia mudou, reinicia a reprodução do ponto atual.
    syncPlayback () {
      if (!this.playing) return
      if (engine.updateMix(this.tracks, this.master)) return
      const { t1, isSelection } = this.playRange
      this.play({ t0: engine.position(), t1, isSelection })
    },

    // ---------- MIDI ----------
    newMidiTrack () {
      this.tracks.forEach(t => { t.selected = false })
      const t = this.addTrack({ kind: 'midi', name: 'Faixa MIDI', notes: [], offset: 0, selected: true })
      this.pushState('Nova faixa MIDI')
      return t
    },

    // Troca as notas da faixa. Com `desc`, registra no histórico; sem, é uma
    // prévia (arrastando no piano roll) e o commit vem depois com pushState.
    setTrackNotes (id, notes, desc = null, consolidate = false) {
      const t = this.findTrack(id)
      if (!t || !isMidi(t)) return
      setNotes(t, notes)
      if (desc) this.pushState(desc, consolidate)
    },

    setInstrument (id, value) {
      const t = this.findTrack(id)
      if (value === 128) { t.drum = true } else { t.drum = false; t.program = value }
      t.version = version++
      this.pushState('Instrumento alterado')
    },

    setTempo (bpm) {
      this.tempo = Math.max(20, Math.min(300, Number(bpm) || 120))
      this.pushState('Andamento alterado', true)
    },

    exportMidi () {
      let tracks = this.midiTracks.filter(t => t.selected)
      if (!tracks.length) tracks = this.midiTracks
      if (!tracks.length) throw new Error('Não há faixas MIDI no projeto.')
      download(writeMidi(tracks, this.tempo), `${this.name}.mid`)
    },

    // Converte a faixa MIDI em áudio (sintetizador + efeitos da faixa) numa faixa nova.
    async renderMidiToAudio (id) {
      const t = this.findTrack(id)
      if (!t || !isMidi(t) || !t.notes.length) throw new Error('Selecione uma faixa MIDI com notas.')
      const tail = 1.5 // cauda para o release das notas
      const solo = { ...toRaw(t), gain: 0, pan: 0, mute: false, solo: false }
      const channels = await engine.render({
        tracks: [solo], rate: this.rate, t0: t.offset, t1: this.trackEnd(t) + tail,
        master: this.master, applyMaster: false, channels: 2
      })
      const index = this.tracks.indexOf(t)
      const audio = makeTrack({ name: `${t.name} (áudio)`, channels, offset: t.offset, gain: t.gain, pan: t.pan, color: t.color, selected: true })
      t.selected = false
      t.mute = true
      this.tracks.splice(index + 1, 0, audio)
      this.pushState(`MIDI renderizado em áudio: "${t.name}"`)
    },

    // ---------- Efeitos e geradores ----------
    requireAudioTargets () {
      const targets = this.requireTargets().filter(isAudio)
      if (!targets.length) throw new Error('Este comando vale só para faixas de áudio. Para MIDI, use o piano roll ou os efeitos em tempo real.')
      return targets
    },

    applyEffect (def, params) {
      const targets = this.requireAudioTargets()
      let newLength = null
      for (const t of targets) {
        const [s0, s1] = this.regionOf(t)
        if (s1 <= s0) continue
        const region = t.channels.map(ch => ch.slice(s0, s1))
        const out = def.process(region, params, { rate: this.rate })
        setChannels(t, t.channels.map((ch, c) => replaceRange(ch, s0, s1, out[c])))
        if (newLength === null) newLength = out[0].length
      }
      if (newLength === null) throw new Error('Não há áudio na seleção.')
      if (this.hasSelection) this.setSelection(this.sel.t0, this.sel.t0 + newLength / this.rate)
      this.pushState(`Aplicado ${def.name.replace('…', '')}`)
    },

    generate (def, params) {
      let targets = this.selectedTracks.filter(isAudio)
      const replace = this.hasSelection && targets.length > 0
      const t0 = this.sel.t0
      const length = Math.round((replace ? this.sel.t1 - t0 : params.duration) * this.rate)
      if (!targets.length) {
        this.tracks.forEach(t => { t.selected = false })
        this.addTrack({ name: def.name.replace('…', ''), channels: [zeros(0)], offset: t0, selected: true })
        targets = this.selectedTracks
      }
      for (const t of targets) {
        const data = def.generate(params, { rate: this.rate, channels: t.channels.length, length })
        if (replace) this.deleteRange(t, t0, this.sel.t1)
        this.insertAtTime(t, t0, { kind: 'audio', channels: data })
      }
      this.setSelection(t0, t0 + length / this.rate)
      this.pushState(`Gerado ${def.name.replace('…', '')}`)
    },

    // ---------- Zoom e rolagem ----------
    clampScroll (t) {
      const max = Math.max(0, this.duration - this.viewSeconds * 0.5)
      return Math.max(0, Math.min(t, max))
    },
    setScroll (t) { this.scrollTime = this.clampScroll(t) },
    zoomAt (factor, anchorTime) {
      const anchorX = (anchorTime - this.scrollTime) * this.pps
      this.pps = Math.max(0.5, Math.min(this.rate * 32, this.pps * factor))
      this.setScroll(anchorTime - anchorX / this.pps)
    },
    zoomIn () { this.zoomAt(2, this.hasSelection ? (this.sel.t0 + this.sel.t1) / 2 : this.sel.t0) },
    zoomOut () { this.zoomAt(0.5, this.hasSelection ? (this.sel.t0 + this.sel.t1) / 2 : this.sel.t0) },
    zoomNormal () { this.pps = 100; this.setScroll(this.scrollTime) },
    zoomFit () {
      if (!this.duration) return
      this.pps = Math.max(0.5, (this.viewWidth - 20) / this.duration)
      this.scrollTime = 0
    },
    zoomSelection () {
      if (!this.hasSelection) return
      this.pps = Math.min(this.rate * 32, this.viewWidth / (this.sel.t1 - this.sel.t0) * 0.95)
      this.scrollTime = Math.max(0, this.sel.t0 - (this.sel.t1 - this.sel.t0) * 0.025)
    },
    ensureVisible (t) {
      if (t < this.scrollTime || t > this.scrollTime + this.viewSeconds) this.setScroll(t - this.viewSeconds * 0.1)
    },

    // ---------- Transporte ----------
    async play ({ t0, t1, isSelection } = {}) {
      if (this.recording) return
      if (t0 === undefined) {
        isSelection = this.hasSelection
        t0 = this.sel.t0
        t1 = isSelection ? this.sel.t1 : this.duration
        if (!isSelection && t0 >= this.duration) t0 = 0
      }
      if (t1 <= t0) return
      await engine.play(this.tracks, this.rate, t0, t1, this.master)
      this.playRange = { t0, t1, isSelection: !!isSelection }
      this.playing = true
      this.paused = false
      this.pausedAt = null
      this.startTicker()
    },

    playStop () { return this.playing || this.recording ? this.stop() : this.play() },

    // Reprodução rápida a partir de um ponto (clicar na régua, "Quick-Play").
    quickPlay (t) {
      this.stop()
      return this.play({ t0: t, t1: Math.max(this.duration, t + 0.001), isSelection: false })
    },

    async togglePause () {
      if (this.playing) {
        this.pausedAt = engine.position()
        engine.stop()
        this.playing = false
        this.paused = true
      } else if (this.paused) {
        const { t1, isSelection } = this.playRange
        await this.play({ t0: this.pausedAt, t1, isSelection })
      }
    },

    stop () {
      if (this.recording) this.stopRecording()
      engine.stop()
      this.playing = false
      this.paused = false
      this.pausedAt = null
      this.playhead = null
      this.levels = { play: [0, 0], rec: 0 }
      cancelAnimationFrame(rafId)
    },

    skipToStart () { this.stop(); this.cursorTo(0) },
    skipToEnd () { this.stop(); this.cursorTo(this.duration) },

    startTicker () {
      cancelAnimationFrame(rafId)
      const tick = () => {
        if (this.recording) {
          this.playhead = rec.t0 + rec.length / this.rate
          this.levels = { play: engine.meterLevels(), rec: engine.captureLevel() }
          this.followPlayhead()
        } else if (this.playing) {
          const pos = engine.position()
          if (pos >= this.playRange.t1) {
            if (this.loop && this.playRange.isSelection) {
              this.play({ ...this.playRange })
              return
            }
            this.stop()
            return
          }
          this.playhead = pos
          this.levels = { play: engine.meterLevels(), rec: 0 }
          this.followPlayhead()
        } else {
          return
        }
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    },

    // Rolagem automática: quando o cursor de reprodução sai da tela, vira a "página".
    followPlayhead () {
      const p = this.playhead
      if (p > this.scrollTime + this.viewSeconds || p < this.scrollTime) this.scrollTime = p
    },

    // ---------- Gravação ----------
    // Como no REAPER: grava nas faixas de áudio selecionadas, a partir do cursor
    // de edição. Faixa mono grava a entrada 1; faixa estéreo, entradas 1/2 (com
    // microfone mono, o mesmo sinal vai para L e R). O trecho gravado substitui
    // o que havia naquele intervalo, sem deslocar o resto da faixa.
    async record () {
      if (this.recording) return
      const targets = this.selectedTracks.filter(isAudio)
      if (!targets.length) {
        throw new Error(this.selectedTracks.length
          ? 'Gravação de MIDI não é suportada. Selecione uma faixa de áudio.'
          : 'Selecione uma faixa de áudio para gravar (Faixas → Nova faixa mono / estéreo).')
      }
      this.stop()
      const t0 = this.sel.t0
      rec = { ids: targets.map(t => t.id), t0, length: 0, buffers: null, lastFlush: 0 }
      try {
        await engine.startCapture(this.rate, chunk => this.onCaptureChunk(chunk), Math.max(...targets.map(t => t.channels.length)))
      } catch (e) {
        rec = null
        throw new Error(`Não foi possível acessar o microfone: ${e.message}`)
      }
      // Overdub: toca o projeto a partir do cursor enquanto grava.
      if (this.duration > t0) await engine.play(this.tracks, this.rate, t0, this.duration, this.master)
      this.recTake = { ids: rec.ids, t0, length: 0 }
      this.recording = true
      this.startTicker()
    },

    onCaptureChunk (chunk) {
      if (!rec) return
      const frames = chunk[0].length
      if (!rec.buffers) rec.buffers = [0, 1].map(() => new Float32Array(this.rate * 10))
      if (rec.length + frames > rec.buffers[0].length) {
        rec.buffers = rec.buffers.map(b => {
          const bigger = new Float32Array(b.length * 2)
          bigger.set(b)
          return bigger
        })
      }
      // Guarda sempre entrada 1 e 2 (a 2 repete a 1 se o dispositivo for mono).
      rec.buffers[0].set(chunk[0], rec.length)
      rec.buffers[1].set(chunk[1] ?? chunk[0], rec.length)
      rec.length += frames
      const now = performance.now()
      if (now - rec.lastFlush > 150) this.flushRecording(now)
    },

    // Atualiza só a prévia (o desenho ao vivo); o áudio entra na faixa ao parar.
    flushRecording (now = performance.now()) {
      if (!rec) return
      rec.lastFlush = now
      this.recTake = { ids: rec.ids, t0: rec.t0, length: rec.length }
    },

    // Canais capturados até agora, no formato da faixa (para o desenho ao vivo).
    recordingPreview (track) {
      if (!rec?.buffers || !rec.ids.includes(track.id)) return null
      const n = track.channels.length
      return rec.buffers.slice(0, n).map(b => b.subarray(0, rec.length))
    },

    // Escreve `data` a partir do tempo t, sobrescrevendo (sem deslocar o resto).
    overwriteAt (track, t, data) {
      let channels = track.channels
      if (!channels[0].length) {
        track.offset = t
        setChannels(track, data)
        return
      }
      let s = this.toSample(track, t)
      if (s < 0) {
        channels = channels.map(ch => concat([zeros(-s), ch]))
        track.offset = t
        s = 0
      }
      const end = s + data[0].length
      setChannels(track, channels.map((ch, c) => {
        const out = new Float32Array(Math.max(ch.length, end))
        out.set(ch)
        out.set(data[c], s)
        return out
      }))
    },

    stopRecording () {
      if (!rec) return
      engine.stopCapture()
      engine.stop()
      const { t0, length, ids, buffers } = rec
      rec = null
      this.recording = false
      this.recTake = null
      this.playhead = null
      cancelAnimationFrame(rafId)
      if (!buffers || !length) return
      for (const id of ids) {
        const track = this.findTrack(id)
        if (!track) continue
        // Mono: entrada 1. Estéreo: entradas 1 e 2.
        const data = buffers.slice(0, track.channels.length).map(b => b.slice(0, length))
        this.overwriteAt(track, t0, data)
      }
      this.setSelection(t0, t0 + length / this.rate)
      this.pushState(ids.length > 1 ? `Gravado áudio em ${ids.length} faixas` : 'Gravado áudio')
    }
  }
})
