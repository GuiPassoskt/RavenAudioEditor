// Cenário da Fase 4 (etapa A) pela interface: instrumento virtual numa faixa MIDI.
// Escolhe o instrumento no cabeçalho da faixa, toca, faz a nota avulsa pela faixa,
// renderiza o MIDI em áudio, volta ao sintetizador e desfaz, abre a janela do
// instrumento e confere o arquivo de projeto. Toca uma bateria baixa por ~2 s.
//
//   node instrument-flow.mjs [pasta-dos-prints] [porta] [nome-do-instrumento]
//
// Usa "Black Pearl Drumkit" (LV2, AVL Drumkits) por padrão.

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { connect } from './cdplib.mjs'

const outDir = process.argv[2] ?? 'raven-prints'
const port = Number(process.argv[3] ?? 9333)
const instrumentName = process.argv[4] ?? 'Black Pearl Drumkit'
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
const desc = () => c.evaluate(`${P}.history[${P}.historyIndex].desc`)
// Pico dos medidores de saída durante `ms` milissegundos.
const listen = ms => c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
  let p = 0; const t0 = performance.now()
  while (performance.now() - t0 < ${ms}) { p = Math.max(p, ...engine.meterLevels()); await new Promise(r => setTimeout(r, 30)) }
  return +p.toFixed(4) })`)

try {
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`Object.assign(${UI}, { splashOpen: false, pluginEffect: false, effect: null, audioDevicesOpen: false, aboutOpen: false, fxTarget: null, pianoRoll: null, instrumentPicker: null })`)
  await c.evaluate(`${P}.stop(); ${P}.resetProject()`)
  await c.sleep(1200)

  // Faixa MIDI com um compasso de bateria (bumbo, caixa, chimbal).
  await c.menu('Faixas', 'Nova faixa MIDI')
  await c.sleep(800)
  await c.evaluate(`(() => { const s = ${P}; const t = s.tracks[0]; const n = (pitch, start) => ({ id: 'n' + pitch + start, pitch, start, dur: 0.15, vel: 110 })
    s.setTrackNotes(t.id, [n(36, 0), n(42, 0.25), n(38, 0.5), n(42, 0.75), n(36, 1), n(42, 1.25), n(38, 1.5)], 'Notas')
    s.setTrackProp(t.id, 'gain', -12); ${UI}.pianoRoll = null })()`)
  await c.sleep(600)

  // Cabeçalho da faixa → instrumento → Plugin (VSTi)… → escolher.
  await c.clickText('Piano', '.track-header .instrument, .instrument')
  await c.sleep(500)
  await c.clickText('Plugin (VSTi)', '.q-menu .q-item')
  await c.waitFor(`!!document.querySelector('.picker-card') && !document.querySelector('.picker-card .q-field--loading')`, 60000)
  await c.sleep(500)
  const field = await c.evaluate(`(() => { const r = document.querySelector('.picker-card .q-field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await c.clickAt(field.x, field.y); await c.sleep(400)
  await c.type(instrumentName); await c.sleep(600)
  await c.clickText(instrumentName, '.q-menu .q-item'); await c.sleep(400)
  await c.clickText('Usar', '.picker-card button')
  await c.sleep(1500)
  const instrument = await c.evaluate(`${P}.tracks[0].instrument?.plugin.name`)
  check(instrument === instrumentName && (await desc()) === `Instrumento: ${instrumentName}`, 'instrumento escolhido no cabeçalho da faixa', `${instrument} · "${await desc()}"`)
  await shot('30-instrumento.png')

  // Tocar.
  // Depois de escolher no seletor, o foco fica nele e o Espaço não chega ao atalho (como ao digitar num campo).
  await c.evaluate(`${P}.cursorTo(0); document.activeElement?.blur()`)
  await c.key(' ', { code: 'Space', keyCode: 32 })
  const playing = await listen(1500)
  await c.evaluate(`${P}.stop()`)
  check(playing > 0.01, 'a faixa toca no instrumento', `pico ${playing}`)

  // Nota avulsa pela faixa (o que o piano roll faz ao clicar no teclado).
  await c.sleep(1200)
  await c.evaluate(`import('/src/audio/engine.js').then(({ engine }) => { const t = ${P}.tracks[0]; engine.auditionNote(${P}.rate, 38, t.program, t.drum, 110, t.id) })`)
  const audition = await listen(500)
  check(audition > 0.01, 'nota avulsa toca pelo instrumento', `pico ${audition}`)

  // Renderizar MIDI em áudio.
  await c.evaluate(`${P}.tracks.forEach((t, i) => { t.selected = i === 0 })`)
  await c.menu('Faixas', 'Renderizar MIDI em áudio')
  await c.waitFor(`${P}.tracks.length === 2`, 30000)
  const rendered = await c.evaluate(`(() => { const ch = ${P}.tracks[1].channels[0]; let p = 0; for (const x of ch) p = Math.max(p, Math.abs(x)); return { name: ${P}.tracks[1].name, seconds: +(ch.length / ${P}.rate).toFixed(2), peak: +p.toFixed(3) } })()`)
  check(rendered.peak > 0.05, 'MIDI renderizado em áudio com o instrumento', JSON.stringify(rendered))
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 }); await c.sleep(600)

  // Voltar ao sintetizador embutido e desfazer.
  await c.evaluate(`${P}.setInstrument(${P}.tracks[0].id, 0)`); await c.sleep(400)
  const afterGm = await c.evaluate(`${P}.tracks[0].instrument`)
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 }); await c.sleep(800)
  const afterUndo = await c.evaluate(`${P}.tracks[0].instrument?.plugin.name`)
  check(afterGm === null && afterUndo === instrumentName, 'trocar para o sintetizador e desfazer', `${afterGm} -> ${afterUndo}`)

  // Janela do instrumento pelo botão do cabeçalho.
  await c.clickText('open_in_new', '.instrument ~ .q-btn, .midi-row .q-btn')
  await c.sleep(1500)
  const open = await c.evaluate(`import('/src/audio/engine-native.js').then(m => m.chainPlugin.info(${P}.tracks[0].instrument.uid)).then(i => i.editorOpen)`)
  await c.evaluate(`import('/src/audio/engine-native.js').then(m => m.chainPlugin.closeEditor(${P}.tracks[0].instrument.uid))`)
  check(open, 'janela do instrumento abre pelo cabeçalho da faixa')

  // Arquivo de projeto.
  const roundTrip = await c.evaluate(`(async () => {
    const { encodeProject, decodeProject } = await import('/src/audio/fileio.js')
    const s = ${P}
    const back = await decodeProject(encodeProject({ name: 'teste', rate: s.rate, tempo: s.tempo, tracks: s.tracks, master: s.master }))
    return back.tracks[0].instrument?.plugin.name
  })()`)
  check(roundTrip === instrumentName, 'projeto salva o instrumento', String(roundTrip))

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
