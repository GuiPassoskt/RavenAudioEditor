// Configuração do Quasar CLI (Vite). https://v2.quasar.dev/quasar-cli-vite/quasar-config-file
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const resolve = (dir) => fileURLToPath(new URL(dir, import.meta.url))

// Motor de áudio nativo (JUCE), gerado por "npm run build:engine". Executáveis não
// rodam de dentro do app.asar, então ele vai como recurso extra, ao lado do asar.
const engineBinary = resolve(
  process.platform === 'win32' ? './engine/bin/raven-engine.exe'
    : process.platform === 'darwin' ? './engine/bin/raven-engine.app'
      : './engine/bin/raven-engine'
)
const engineResources = existsSync(engineBinary) ? [engineBinary] : []

// Commit do build: a tela "Sobre" aponta o código-fonte exato desta versão (AGPLv3).
const gitCommit = (() => {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() } catch { return '' }
})()

export default (ctx) => ({
  boot: [],
  css: ['app.scss'],
  extras: ['roboto-font', 'material-icons', 'material-symbols-rounded', 'mdi-v7'],
  build: {
    // GitHub Pages serve em /raven-audio-editor-live/; o Electron carrega via file:// e precisa de caminho relativo.
    publicPath: ctx.prod && !ctx.mode.electron ? '/raven-audio-editor-live/' : '/',
    target: { browser: ['es2022', 'firefox115', 'chrome115', 'safari15'], node: 'node20' },
    vueRouterMode: 'hash',
    // A partir do @quasar/app-vite v3 só '@' e '#q-app' são aliases padrão.
    alias: {
      src: resolve('./src'),
      components: resolve('./src/components'),
      layouts: resolve('./src/layouts'),
      pages: resolve('./src/pages'),
      assets: resolve('./src/assets'),
      stores: resolve('./src/stores')
    },
    // Disponíveis no app como import.meta.env.BUILD_DATE (splash) e GIT_COMMIT (Sobre).
    defineEnv: { BUILD_DATE: new Date().toISOString(), GIT_COMMIT: gitCommit }
  },
  devServer: { open: !ctx.mode.electron },
  framework: {
    config: { dark: true },
    plugins: ['Notify', 'Dialog', 'Loading']
  },
  sourceFiles: {
    electronMain: 'src-electron/electron-main'
  },
  // https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/configuring-electron
  electron: {
    preloadScripts: ['electron-preload'],
    inspectPort: 5858,
    // 'packager' (@electron/packager) ou 'builder' (electron-builder, gera instalador)
    bundler: 'packager',
    packager: {
      // https://electron.github.io/packager/main/interfaces/Options.html
      appCopyright: 'Raven Audio Editor',
      executableName: 'raven-audio-editor',
      extraResource: engineResources
    },
    builder: {
      // https://www.electron.build/configuration
      appId: 'br.com.hba.raven-audio-editor',
      productName: 'Raven Audio Editor',
      extraResources: engineResources,
      win: { target: 'nsis' }
    }
  }
})
