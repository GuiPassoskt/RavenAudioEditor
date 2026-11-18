import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import {
  registerQuasarRuntime,
  resolveElectronAssetsPath
} from '#q-app/electron/main'
import { EngineHost } from './engine-host.js'

// needed in case process is undefined under Linux
const platform = process.platform || os.platform()

// Comandos do motor nativo que a interface pode pedir (engine/src/PluginHost.cpp
// e engine/src/AudioEngine.cpp). Os que trocam áudio passam por arquivos temporários.
const ENGINE_COMMANDS = new Set([
  'ping', 'plugins.list', 'fx.create', 'fx.setParam', 'fx.openEditor', 'fx.closeEditor', 'fx.destroy',
  'audio.status', 'audio.devices', 'audio.setDevice', 'project.sync', 'project.setRate', 'clips.release',
  'transport.play', 'transport.stop', 'preview.stop', 'synth.audition', 'capture.start', 'capture.stop',
  'project.pluginInfo', 'project.setPluginParam', 'project.openPluginEditor', 'project.closePluginEditor',
  'midi.devices', 'midi.setInput', 'midi.startRecording', 'midi.read', 'midi.stopRecording', 'midi.simulate',
  'render.cancel'
])
const ENGINE_SEND_AUDIO = new Set(['clips.load', 'preview.play'])
const ENGINE_RECEIVE_AUDIO = new Set(['render.offline', 'capture.read'])

const allowed = (set, cmd) => {
  if (!set.has(cmd)) throw new Error(`Comando do motor não permitido: ${cmd}`)
}

const engine = new EngineHost({
  onEvent: (name, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engine:event', name, payload)
  }
})

function registerEngineIpc () {
  ipcMain.handle('engine:status', () => engine.status())
  ipcMain.handle('engine:request', (_e, cmd, args) => {
    allowed(ENGINE_COMMANDS, cmd)
    return engine.request(cmd, args)
  })
  ipcMain.handle('engine:sendAudio', (_e, cmd, args, channels) => {
    allowed(ENGINE_SEND_AUDIO, cmd)
    return engine.sendAudio(cmd, args, channels)
  })
  ipcMain.handle('engine:receiveAudio', (_e, cmd, args) => {
    allowed(ENGINE_RECEIVE_AUDIO, cmd)
    return engine.receiveAudio(cmd, args)
  })
  ipcMain.handle('engine:scan', (_e, options) => engine.scan(options))
  ipcMain.handle('engine:process', (_e, instanceId, channels, sampleRate) => engine.process(instanceId, channels, sampleRate))
}

async function createWindow () {
  /**
   * Initial window options
   */
  const mainWindow = new BrowserWindow({
    icon: resolveElectronAssetsPath('icons/icon.png'), // Windows and Linux
    width: 1280,
    minWidth: 960,
    height: 800,
    minHeight: 600,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      // https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.join(import.meta.dirname, 'electron-preload.cjs')
    }
  })

  mainWindow.removeMenu()

  // Links externos (código-fonte, licenças) abrem no navegador do sistema, nunca numa janela do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Com alterações não salvas, a página bloqueia o fechamento (beforeunload, em
  // EditorPage.vue). O navegador perguntaria ao usuário; o Electron só cancela em
  // silêncio, e o botão fechar parecia não funcionar. Aqui o fechamento fica
  // cancelado e a interface pergunta, com o diálogo do próprio app; se o usuário
  // confirmar, ela pede "app:close" e o bloqueio passa a ser ignorado.
  let closeConfirmed = false
  mainWindow.webContents.on('will-prevent-unload', event => {
    if (closeConfirmed) event.preventDefault()
    else mainWindow.webContents.send('app:confirm-close')
  })
  ipcMain.removeHandler('app:close')
  ipcMain.handle('app:close', () => {
    closeConfirmed = true
    mainWindow.close()
  })

  if (import.meta.env.QUASAR_DEV) {
    await mainWindow.loadURL(import.meta.env.QUASAR_APP_URL)
  } else {
    await mainWindow.loadFile('index.html')
  }

  if (import.meta.env.QUASAR_DEBUG) {
    // if on DEV or Production with debug enabled
    mainWindow.webContents.openDevTools()
  } else {
    // we're on production; no access to devtools pls
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools()
    })
  }
}

void app.whenReady().then(() => {
  registerQuasarRuntime()
  registerEngineIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => engine.stop())

app.on('window-all-closed', () => {
  if (platform !== 'darwin') {
    app.quit()
  }
})
