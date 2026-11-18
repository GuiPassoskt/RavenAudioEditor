// Gera src/legal/third-party-licenses.json: componentes de terceiros distribuídos
// com o Raven Audio Editor e o texto de cada licença (mostrado na tela "Sobre").
//
//   npm run licenses
//
// Fontes: package.json/LICENSE em node_modules (interface e Electron) e o
// inventário SPDX do JUCE (engine/third_party/JUCE/JUCE.spdx.json) para o motor.
// Rode de novo ao adicionar ou atualizar dependências.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const juceDir = path.join(root, 'engine/third_party/JUCE')
const output = path.join(root, 'src/legal/third-party-licenses.json')

// Pacotes npm que vão de fato para o app (o resto do node_modules é ferramenta de build).
const RUNTIME_PACKAGES = [
  'vue', '@vue/runtime-dom', '@vue/runtime-core', '@vue/reactivity', '@vue/shared',
  'quasar', 'pinia', 'vue-router', '@vue/devtools-api'
]

// Fontes e ícones do @quasar/extras usados em quasar.config.js > extras.
const QUASAR_EXTRAS = {
  'roboto-font': { name: 'Roboto (fonte)', license: 'Apache-2.0' },
  'material-icons': { name: 'Material Icons', license: 'Apache-2.0' },
  'material-symbols-rounded': { name: 'Material Symbols Rounded', license: 'Apache-2.0' },
  'mdi-v7': { name: 'Material Design Icons v7', license: 'Apache-2.0' }
}

// Componentes do inventário do JUCE que não entram no motor do Raven
// (Android, formatos de plugin que não geramos, exemplos e ferramentas).
const JUCE_EXCLUDED = new Set([
  'examples', 'extras', 'build-system', 'Oboe', 'AAX SDK', '@juce-framework/webview',
  'reaper-sdk', 'Box2D', 'Box2D testbed', 'Projucer icons', 'Gradle wrapper', 'OpenGL registry headers'
])

const LICENSE_FILE = /^(licen[cs]e|copying|copyright)/i

function licenseText (dir) {
  if (!existsSync(dir)) return null
  const base = statSync(dir).isDirectory() ? dir : path.dirname(dir)
  const files = readdirSync(base).filter(f => LICENSE_FILE.test(f) || /licen[cs]e/i.test(f)).sort()
  if (!files.length) return null
  return files.map(f => readFileSync(path.join(base, f), 'utf8').trim()).join('\n\n')
}

function npmPackage (dir, origin, overrides = {}) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    url: pkg.homepage ?? repo?.replace(/^git\+/, '').replace(/\.git$/, ''),
    origin,
    text: licenseText(dir),
    ...overrides
  }
}

const components = []

for (const name of RUNTIME_PACKAGES) {
  const dir = path.join(root, 'node_modules', name)
  if (existsSync(dir)) components.push(npmPackage(dir, 'Interface'))
  else console.warn(`aviso: ${name} não está instalado`)
}

const extrasDir = path.join(root, 'node_modules/@quasar/extras')
const extrasVersion = JSON.parse(readFileSync(path.join(extrasDir, 'package.json'), 'utf8')).version
for (const [folder, info] of Object.entries(QUASAR_EXTRAS)) {
  components.push({
    name: info.name,
    version: `@quasar/extras ${extrasVersion}`,
    license: info.license,
    url: 'https://github.com/quasarframework/quasar/tree/dev/extras',
    origin: 'Interface',
    text: licenseText(path.join(extrasDir, folder))
  })
}

const electronDir = path.join(root, 'src-electron/node_modules/electron')
if (existsSync(electronDir)) {
  components.push(npmPackage(electronDir, 'Desktop', {
    text: licenseText(electronDir) +
      '\n\nO Electron inclui o Chromium e outros componentes; as licenças deles estão no arquivo ' +
      'LICENSES.chromium.html distribuído junto com o aplicativo desktop.'
  }))
}

const spdx = JSON.parse(readFileSync(path.join(juceDir, 'JUCE.spdx.json'), 'utf8'))
for (const p of spdx.packages) {
  if (JUCE_EXCLUDED.has(p.name) || p.name.startsWith('juce_')) continue
  const vendored = /Vendored at (\S+)/.exec(p.sourceInfo ?? '')?.[1]
  const isJuce = p.name === 'JUCE'
  const text = isJuce
    ? 'Usado sob a GNU Affero General Public License v3 (a mesma do Raven Audio Editor; texto no arquivo LICENSE).'
    : (vendored && licenseText(path.join(juceDir, vendored))) ??
      `Texto da licença no cabeçalho dos arquivos-fonte (engine/third_party/JUCE/${vendored ?? ''}).`
  components.push({
    name: p.name,
    version: p.versionInfo === 'NOASSERTION' ? '' : p.versionInfo,
    license: isJuce ? 'AGPL-3.0-only' : (p.licenseConcluded ?? p.licenseDeclared),
    url: p.downloadLocation === 'NOASSERTION' ? undefined : p.downloadLocation,
    origin: 'Motor (JUCE)',
    text
  })
}

mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(components, null, 1) + '\n')
console.log(`${components.length} componentes -> ${path.relative(root, output)}`)
for (const c of components.filter(c => !c.text)) console.warn(`aviso: sem texto de licença para ${c.name}`)
