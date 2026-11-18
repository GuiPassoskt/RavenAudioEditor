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

// Comandos do motor nativo que a interface pode pedir (engine/src/PluginHost.cpp).
const ENGINE_COMMANDS = new Set([
  'ping', 'plugins.list', 'fx.create', 'fx.setParam', 'fx.openEditor', 'fx.closeEditor', 'fx.destroy'
])

const engine = new EngineHost({
  onEvent: (name, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engine:event', name, payload)
  }
})

function registerEngineIpc () {
  ipcMain.handle('engine:status', () => engine.status())
  ipcMain.handle('engine:request', (_e, cmd, args) => {
    if (!ENGINE_COMMANDS.has(cmd)) throw new Error(`Comando do motor não permitido: ${cmd}`)
    return engine.request(cmd, args)
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
