// Cenário da Fase 3 pela interface: plugin VST3 numa cadeia em tempo real.
// Adiciona o kHs Gain pelo painel de efeitos, ajusta o Gain no slider genérico,
// confere histórico, desfazer/refazer, liga/desliga tocando, janela nativa e o
// estado salvo no arquivo de projeto. Toca um tom baixo por ~1,5 s.
//
//   node chain-flow.mjs [pasta-dos-prints] [porta]

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { connect } from './cdplib.mjs'

const outDir = process.argv[2] ?? 'raven-prints'
const port = Number(process.argv[3] ?? 9333)
mkdirSync(outDir, { recursive: true })

const c = await connect(port)
const shot = name => c.shot(path.join(outDir, name))
const store = name => `document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia._s.get('${name}')`
const P = store('project')
const UI = store('ui')
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const slotFx = () => c.evaluate(`(() => { const fx = ${P}.tracks[0]?.effects.find(e => e.type === 'plugin'); return fx && { uid: fx.uid, state: fx.state ? fx.state.length : null, version: fx.stateVersion, enabled: fx.enabled } })()`)
const pluginGain = uid => c.evaluate(`import('/src/audio/engine-native.js').then(m => m.chainPlugin.info(${uid})).then(i => i.params.find(p => p.name === 'Gain').text)`)
// Pico do render offline do projeto atual (motor nativo, com a cadeia da faixa).
const renderPeak = () => c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
  const s = ${P}; const [l] = await engine.render({ tracks: s.tracks, rate: s.rate, t0: 0, t1: 1, master: s.master, channels: 2 })
  let p = 0; for (const x of l.subarray(l.length / 2)) p = Math.max(p, Math.abs(x)); return +p.toFixed(4) })`)

try {
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`Object.assign(${UI}, { splashOpen: false, pluginEffect: false, effect: null, audioDevicesOpen: false, aboutOpen: false, fxTarget: null })`)
  await c.evaluate(`${P}.stop(); ${P}.resetProject()`)
  await c.sleep(1200) // a tela de abertura some com animação e engole cliques

  // Faixa estéreo com tom de 5 s (pico 0,8).
  await c.menu('Faixas', 'Nova faixa estéreo'); await c.sleep(600)
  await c.menu('Gerar', 'Tom'); await c.sleep(700)
  await c.clickText('Aplicar', '.effect-card button'); await c.sleep(1200)
  await c.evaluate(`${P}.selectNone(); ${P}.cursorTo(0)`)

  // Painel de efeitos da faixa → Adicionar efeito → Plugin… → kHs Gain.
  await c.evaluate(`${UI}.fxTarget = ${P}.tracks[0].id`); await c.sleep(600)
  await c.clickText('Adicionar efeito', '.fx-panel button'); await c.sleep(500)
  await c.clickText('Plugin (VST3 / LV2)', '.q-menu .q-item'); await c.sleep(800)
  await c.waitFor(`!document.querySelector('.picker-card .q-field--loading') && !document.querySelector('.picker-card .q-btn .q-spinner')`, 120000)
  const field = await c.evaluate(`(() => { const r = document.querySelector('.picker-card .q-field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await c.clickAt(field.x, field.y); await c.sleep(400)
  await c.type('kHs Gain'); await c.sleep(600)
  await c.clickText('kHs Gain', '.q-menu .q-item'); await c.sleep(400)
  await c.clickText('Adicionar', '.picker-card button')
  await c.waitFor(`!!document.querySelector('.fx-card .slot-body .q-btn')`, 30000)
  await c.sleep(500)
  const added = await slotFx()
  check(!!added && (await c.evaluate(`${P}.history[${P}.historyIndex].desc`)).startsWith('Adicionado kHs Gain'), 'plugin adicionado à cadeia pelo painel', JSON.stringify(added))
  const dryPeak = await renderPeak()

  // Parâmetros genéricos: Gain a 20% (≈ −18 dB).
  await c.clickText('Parâmetros', '.fx-card .slot-body'); await c.sleep(500)
  const slider = await c.evaluate(`(() => { const row = [...document.querySelectorAll('.fx-card .slot-body .q-gutter-y-sm > div')].find(d => d.innerText.startsWith('Gain'));
    const r = row.querySelector('.q-slider').getBoundingClientRect(); return { x: r.x + r.width * 0.2, y: r.y + r.height / 2 } })()`)
  await c.clickAt(slider.x, slider.y)
  await c.sleep(1200)
  await shot('20-plugin-na-cadeia.png')
  const tweaked = await slotFx()
  const desc = await c.evaluate(`${P}.history[${P}.historyIndex].desc`)
  check(tweaked.state > 0 && desc === 'Plugin ajustado: kHs Gain', 'ajuste do plugin entra no histórico', `${desc}, estado com ${tweaked.state} caracteres`)
  const wetPeak = await renderPeak()
  const gainDb = 20 * Math.log10(wetPeak / dryPeak)
  check(Math.abs(gainDb + 18) < 0.5, 'render com o plugin ajustado', `${dryPeak} -> ${wetPeak} (${gainDb.toFixed(2)} dB)`)

  // Desfazer e refazer.
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 }); await c.sleep(900)
  const undoneState = (await slotFx()).state
  const undoneText = await pluginGain(tweaked.uid)
  await c.key('y', { ctrl: true, code: 'KeyY', keyCode: 89 }); await c.sleep(900)
  const redoneText = await pluginGain(tweaked.uid)
  check(undoneState === null && undoneText.includes('0.00') && redoneText.includes('18'), 'desfazer e refazer o ajuste', `${undoneText} -> ${redoneText}`)

  // Tocando: desligar o plugin aumenta o nível na hora, sem reiniciar.
  await c.evaluate(`${P}.setTrackProp(${P}.tracks[0].id, 'gain', -12)`)
  await c.evaluate(`${P}.play({ t0: 0, t1: 3, isSelection: false })`)
  await c.sleep(700)
  const level = () => c.evaluate(`import('/src/audio/engine.js').then(({ engine }) => ({ pos: engine.position(), level: Math.max(...engine.meterLevels()) }))`)
  const on = await level()
  await c.evaluate(`${P}.toggleRealtimeEffect(${P}.tracks[0].id, ${tweaked.uid})`)
  await c.sleep(600)
  const off = await level()
  await c.evaluate(`${P}.stop()`)
  check(off.pos > on.pos && Math.abs(20 * Math.log10(off.level / on.level) - 18) < 1.5, 'liga/desliga tocando, sem reiniciar',
    `${on.level.toFixed(4)} -> ${off.level.toFixed(4)}, posição ${on.pos.toFixed(2)} -> ${off.pos.toFixed(2)} s`)
  await c.evaluate(`${P}.toggleRealtimeEffect(${P}.tracks[0].id, ${tweaked.uid})`)

  // Janela nativa pelo botão "Interface".
  await c.clickText('Interface', '.fx-card .slot-body button'); await c.sleep(1500)
  const open = await c.evaluate(`import('/src/audio/engine-native.js').then(m => m.chainPlugin.info(${tweaked.uid})).then(i => i.editorOpen)`)
  await c.evaluate(`import('/src/audio/engine-native.js').then(m => m.chainPlugin.closeEditor(${tweaked.uid}))`)
  check(open, 'janela nativa do plugin abre pelo painel')

  // Arquivo de projeto: plugin e estado vão e voltam.
  const roundTrip = await c.evaluate(`(async () => {
    const { encodeProject, decodeProject } = await import('/src/audio/fileio.js')
    const s = ${P}
    const back = await decodeProject(encodeProject({ name: 'teste', rate: s.rate, tempo: s.tempo, tracks: s.tracks, master: s.master }))
    const fx = back.tracks[0].effects[0]
    return { type: fx.type, plugin: fx.plugin?.name, igual: fx.state === s.tracks[0].effects[0].state }
  })()`)
  check(roundTrip.type === 'plugin' && roundTrip.plugin === 'kHs Gain' && roundTrip.igual, 'projeto salva plugin e estado', JSON.stringify(roundTrip))

  const notes = await c.evaluate(`[...document.querySelectorAll('.q-notification')].map(n => n.innerText)`)
  check(!notes.length, 'sem mensagens de erro', notes.join(' | '))
} catch (e) {
  failures++
  console.log('FALHA', e.message)
  await shot('erro.png').catch(() => {})
} finally {
  c.close()
}

console.log(failures ? `\n${failures} verificação(ões) falharam. Prints em ${outDir}` : `\nTudo certo. Prints em ${outDir}`)
process.exit(failures ? 1 : 0)
