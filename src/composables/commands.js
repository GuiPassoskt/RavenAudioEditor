// Registro central de comandos: rótulo, ícone, atalho e ação.
//
// Mesmo papel do CommandManager + registros de menu do Audacity
// (lib-menus/CommandManager.cpp, src/menus/*Menus.cpp): menus, barras de
// ferramentas e teclado disparam o mesmo comando pelo seu id.

import { Dialog, Loading, Notify } from 'quasar'
import { useProjectStore } from 'src/stores/project'
import { useUiStore } from 'src/stores/ui'
import { EFFECTS, GENERATORS, ANALYZERS } from 'src/audio/effects'
import { pickFiles } from 'src/audio/fileio'

export function notifyError (e) {
  Notify.create({ type: 'negative', message: e?.message ?? String(e), position: 'bottom', timeout: 3500 })
}

// Executa uma ação capturando erros (síncronos ou assíncronos) e mostrando-os.
export async function guard (fn, { loading = false } = {}) {
  if (loading) {
    Loading.show({ message: 'Processando…' })
    await new Promise(r => setTimeout(r, 30)) // deixa o overlay aparecer
  }
  try {
    return await fn()
  } catch (e) {
    notifyError(e)
  } finally {
    if (loading) Loading.hide()
  }
}

function confirmDiscard (store) {
  if (!store.dirty) return Promise.resolve(true)
  return new Promise(resolve => {
    Dialog.create({
      title: 'Alterações não salvas',
      message: 'O projeto atual tem alterações não salvas. Deseja descartá-las?',
      cancel: { label: 'Cancelar', flat: true },
      ok: { label: 'Descartar', color: 'negative' },
      dark: true
    }).onOk(() => resolve(true)).onCancel(() => resolve(false))
  })
}

let registry = null

export function useCommands () {
  if (registry) return registry
  const p = useProjectStore()
  const ui = useUiStore()

  const openEffect = (def, kind) => {
    if (kind === 'effect' && !def.params.length) {
      guard(() => p.applyEffect(def, {}), { loading: true })
      return
    }
    ui.effect = { def, kind }
  }

  const cmds = {
    // Arquivo
    newProject: { label: 'Novo projeto', icon: 'note_add', keys: 'Ctrl+N', run: async () => { if (await confirmDiscard(p)) p.resetProject() } },
    importAudio: {
      label: 'Importar áudio…', icon: 'file_upload', keys: 'Ctrl+Shift+I',
      run: async () => {
        const files = await pickFiles('audio/*,video/*,.mid,.midi,.kar')
        if (files.length) await guard(() => p.importFiles(files), { loading: true })
      }
    },
    openProject: {
      label: 'Abrir projeto…', icon: 'folder_open', keys: 'Ctrl+O',
      run: async () => {
        if (!(await confirmDiscard(p))) return
        const [file] = await pickFiles('.ravenproj,.reaproj', false)
        if (file) await guard(() => p.openProject(file), { loading: true })
      }
    },
    saveProject: { label: 'Salvar projeto (.ravenproj)', icon: 'save', keys: 'Ctrl+S', run: () => p.saveProject() },
    exportWav: { label: 'Exportar como WAV 16-bit', icon: 'ios_share', keys: 'Ctrl+Shift+E', run: () => p.exportWav({ format: 'pcm16' }) },
    exportWavFloat: { label: 'Exportar como WAV 32-bit float', icon: 'ios_share', run: () => p.exportWav({ format: 'float32' }) },
    importMidi: {
      label: 'Importar MIDI…', icon: 'piano',
      run: async () => {
        const files = await pickFiles('.mid,.midi,.kar,audio/midi')
        if (files.length) await guard(() => p.importFiles(files), { loading: true })
      }
    },
    exportMidi: { label: 'Exportar MIDI (.mid) — selecionadas ou todas', icon: 'piano', run: () => p.exportMidi() },
    exportSelection: { label: 'Exportar seleção (WAV)', icon: 'content_cut', run: () => p.exportWav({ scope: 'selection' }) },

    // Editar
    undo: { label: 'Desfazer', icon: 'undo', keys: 'Ctrl+Z', run: () => p.undo(), enabled: () => p.canUndo },
    redo: { label: 'Refazer', icon: 'redo', keys: 'Ctrl+Y', alt: ['Ctrl+Shift+Z'], run: () => p.redo(), enabled: () => p.canRedo },
    cut: { label: 'Recortar', icon: 'content_cut', keys: 'Ctrl+X', run: () => p.cut() },
    copy: { label: 'Copiar', icon: 'content_copy', keys: 'Ctrl+C', run: () => p.copy() },
    paste: { label: 'Colar', icon: 'content_paste', keys: 'Ctrl+V', run: () => p.paste(), enabled: () => p.hasClipboard },
    remove: { label: 'Excluir', icon: 'backspace', keys: 'Delete', alt: ['Backspace'], run: () => p.remove() },
    duplicate: { label: 'Duplicar', icon: 'library_add', keys: 'Ctrl+D', run: () => p.duplicate() },
    silence: { label: 'Silenciar áudio', icon: 'volume_off', keys: 'Ctrl+L', run: () => p.silence() },
    trim: { label: 'Aparar áudio (manter seleção)', icon: 'crop', keys: 'Ctrl+T', run: () => p.trim() },
    splitNew: { label: 'Dividir em nova faixa', icon: 'call_split', keys: 'Ctrl+Alt+I', run: () => p.splitNew() },
    history: { label: 'Histórico…', icon: 'history', keys: 'Ctrl+H', run: () => { ui.historyOpen = !ui.historyOpen } },

    // Selecionar
    selectAll: { label: 'Tudo', icon: 'select_all', keys: 'Ctrl+A', run: () => p.selectAll() },
    selectNone: { label: 'Nada', icon: 'deselect', keys: 'Ctrl+Shift+A', run: () => p.selectNone() },
    selectAllTracks: { label: 'Em todas as faixas', icon: 'view_stream', keys: 'Ctrl+Shift+K', run: () => p.selectAllTracks() },
    selectStartToCursor: { label: 'Início da faixa até o cursor', icon: 'first_page', keys: 'Shift+J', run: () => p.selectStartToCursor() },
    selectCursorToEnd: { label: 'Cursor até o fim da faixa', icon: 'last_page', keys: 'Shift+K', run: () => p.selectCursorToEnd() },

    // Exibir
    zoomIn: { label: 'Aproximar', icon: 'zoom_in', keys: 'Ctrl+1', run: () => p.zoomIn() },
    zoomNormal: { label: 'Zoom normal', icon: 'center_focus_strong', keys: 'Ctrl+2', run: () => p.zoomNormal() },
    zoomOut: { label: 'Afastar', icon: 'zoom_out', keys: 'Ctrl+3', run: () => p.zoomOut() },
    zoomSel: { label: 'Zoom na seleção', icon: 'crop_free', keys: 'Ctrl+E', run: () => p.zoomSelection() },
    zoomFit: { label: 'Ajustar à janela', icon: 'fit_screen', keys: 'Ctrl+F', run: () => p.zoomFit() },
    mixer: { label: 'Mesa de som', icon: 'tune', keys: 'Ctrl+M', run: () => { ui.mixerOpen = !ui.mixerOpen } },

    // Efeitos em tempo real
    trackEffects: {
      label: 'Efeitos em tempo real da faixa…', icon: 'mdi-tune-vertical', keys: 'E',
      run: () => { ui.fxTarget = ui.fxTarget !== null ? null : p.requireTargets()[0].id }
    },
    masterEffects: { label: 'Efeitos do master…', icon: 'mdi-tune-variant', run: () => { ui.fxTarget = 'master' } },

    // Transporte
    playStop: { label: 'Reproduzir / Parar', icon: 'play_arrow', keys: 'Space', run: () => p.playStop() },
    pause: { label: 'Pausar', icon: 'pause', keys: 'P', run: () => p.togglePause() },
    stop: { label: 'Parar', icon: 'stop', run: () => p.stop() },
    record: { label: 'Gravar', icon: 'fiber_manual_record', keys: 'R', run: () => p.record() },
    skipStart: { label: 'Ir para o início', icon: 'skip_previous', keys: 'Home', run: () => p.skipToStart() },
    skipEnd: { label: 'Ir para o fim', icon: 'skip_next', keys: 'End', run: () => p.skipToEnd() },
    loop: { label: 'Repetir seleção (loop)', icon: 'repeat', keys: 'L', run: () => { p.loop = !p.loop } },

    // Ferramentas
    toolSelect: { label: 'Ferramenta de seleção', icon: 'mdi-cursor-text', keys: 'F1', run: () => { p.tool = 'select' } },
    toolShift: { label: 'Ferramenta de mover no tempo', icon: 'mdi-arrow-left-right', keys: 'F5', run: () => { p.tool = 'shift' } },

    // Faixas
    newMono: { label: 'Nova faixa mono', icon: 'add', keys: 'Ctrl+Shift+N', run: () => p.newTrack(1) },
    newMidi: { label: 'Nova faixa MIDI', icon: 'piano', run: () => { ui.pianoRoll = p.newMidiTrack().id } },
    pianoRoll: {
      label: 'Piano roll', icon: 'mdi-piano', keys: 'F7',
      run: () => {
        if (ui.pianoRoll !== null) { ui.pianoRoll = null; return }
        const t = p.selectedTracks.find(x => x.kind === 'midi') ?? p.midiTracks[0]
        if (!t) throw new Error('Não há faixas MIDI. Use Faixas → Nova faixa MIDI ou importe um .mid.')
        ui.pianoRoll = t.id
      }
    },
    renderMidi: {
      label: 'Renderizar MIDI em áudio', icon: 'graphic_eq',
      run: () => {
        const t = p.selectedTracks.find(x => x.kind === 'midi')
        if (!t) throw new Error('Selecione uma faixa MIDI.')
        return guard(() => p.renderMidiToAudio(t.id), { loading: true })
      }
    },
    newStereo: { label: 'Nova faixa estéreo', icon: 'add_circle_outline', run: () => p.newTrack(2) },
    removeTracks: { label: 'Remover faixas selecionadas', icon: 'delete', run: () => p.removeSelectedTracks() },
    mixRender: { label: 'Mixar e renderizar', icon: 'merge_type', run: () => p.mixAndRender() },
    stereoToMono: { label: 'Estéreo para mono', icon: 'call_merge', run: () => p.makeStereoToMono() },

    // Ajuda
    shortcuts: { label: 'Atalhos de teclado', icon: 'keyboard', keys: 'F2', run: () => { ui.shortcutsOpen = true } },
    splash: { label: 'Tela de abertura', icon: 'sym_r_rocket_launch', run: () => { ui.splashOpen = true } },
    about: { label: 'Sobre', icon: 'info', run: () => { ui.aboutOpen = true } }
  }

  for (const def of EFFECTS) cmds[`fx:${def.id}`] = { label: def.name, run: () => openEffect(def, 'effect') }
  for (const def of GENERATORS) cmds[`gen:${def.id}`] = { label: def.name, run: () => openEffect(def, 'generate') }
  for (const def of ANALYZERS) {
    cmds[`an:${def.id}`] = {
      label: def.name,
      run: () => {
        p.requireAudioTargets()
        ui.analysis = def.id
      }
    }
  }

  const exec = id => {
    const c = cmds[id]
    if (!c || (c.enabled && !c.enabled())) return
    return guard(c.run)
  }

  const menus = [
    { label: 'Arquivo', items: ['newProject', 'openProject', 'saveProject', '-', 'importAudio', 'importMidi', '-', 'exportWav', 'exportWavFloat', 'exportSelection', 'exportMidi'] },
    { label: 'Editar', items: ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'remove', '-', 'duplicate', 'silence', 'trim', 'splitNew', '-', 'history'] },
    { label: 'Selecionar', items: ['selectAll', 'selectNone', 'selectAllTracks', '-', 'selectStartToCursor', 'selectCursorToEnd'] },
    { label: 'Exibir', items: ['zoomIn', 'zoomNormal', 'zoomOut', 'zoomSel', 'zoomFit', '-', 'mixer', 'pianoRoll', 'history'] },
    { label: 'Transporte', items: ['playStop', 'pause', 'stop', 'record', '-', 'skipStart', 'skipEnd', 'loop'] },
    { label: 'Faixas', items: ['newMono', 'newStereo', 'newMidi', '-', 'pianoRoll', 'renderMidi', '-', 'mixRender', 'stereoToMono', '-', 'removeTracks'] },
    { label: 'Gerar', items: GENERATORS.map(d => `gen:${d.id}`) },
    { label: 'Efeito', items: ['trackEffects', 'masterEffects', '-', ...EFFECTS.map(d => `fx:${d.id}`)] },
    { label: 'Analisar', items: ANALYZERS.map(d => `an:${d.id}`) },
    { label: 'Ajuda', items: ['splash', 'shortcuts', 'about'] }
  ]

  const keymap = new Map()
  for (const [id, c] of Object.entries(cmds)) {
    for (const k of [c.keys, ...(c.alt ?? [])]) if (k) keymap.set(k, id)
  }

  registry = { cmds, exec, menus, keymap }
  return registry
}

// Converte um KeyboardEvent em "Ctrl+Shift+Z", "Space", "Delete", etc.
export function keyName (e) {
  const parts = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let k = e.key
  if (k === ' ') k = 'Space'
  else if (k.length === 1) k = k.toUpperCase()
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null
  parts.push(k)
  return parts.join('+')
}
