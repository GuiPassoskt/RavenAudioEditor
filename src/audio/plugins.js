// Cliente do motor de áudio nativo (raven-engine), para plugins VST3/LV2.
//
// Só existe no app desktop: o preload do Electron expõe window.audio
// (src-electron/electron-preload.js). No navegador, hasNativeEngine é false.

const bridge = typeof window !== 'undefined' ? window.audio : undefined

export const hasNativeEngine = !!bridge

// O Electron prefixa erros vindos do main: "Error invoking remote method 'x': Error: ...".
const cleanError = e => new Error(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))

// Chama o bridge e devolve erros sem o prefixo do Electron (usado também por engine-native.js).
export async function call (fn) {
  if (!bridge) throw new Error('Plugins nativos só estão disponíveis no aplicativo desktop.')
  try {
    return await fn()
  } catch (e) {
    throw cleanError(e)
  }
}

export const nativePlugins = {
  status: () => call(() => bridge.engineStatus()),
  list: () => call(() => bridge.request('plugins.list')),
  scan: ({ full = false } = {}) => call(() => bridge.scanPlugins({ full })),
  create: (pluginId, sampleRate) => call(() => bridge.request('fx.create', { pluginId, sampleRate })),
  setParam: (instanceId, index, value) => call(() => bridge.request('fx.setParam', { instanceId, index, value })),
  openEditor: instanceId => call(() => bridge.request('fx.openEditor', { instanceId })),
  closeEditor: instanceId => call(() => bridge.request('fx.closeEditor', { instanceId })),
  destroy: instanceId => call(() => bridge.request('fx.destroy', { instanceId })),
  // channels: Float32Array[] -> Float32Array[] processados, com o mesmo tamanho.
  process: (instanceId, channels, sampleRate) => call(() => bridge.process(instanceId, channels, sampleRate)),
  // Eventos do motor: scan.progress, scan.done, fx.paramChanged, fx.editorClosed, engine.exit…
  onEvent: callback => (bridge ? bridge.onEvent(callback) : () => {})
}
