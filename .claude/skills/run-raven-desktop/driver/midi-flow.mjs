// Cenário da Fase 4 (etapas B e C) pela interface: entrada MIDI na faixa
// selecionada (mensagens simuladas com midi.simulate, porque esta máquina não tem
// teclado MIDI), gravação MIDI com R, diálogo de dispositivos (MIDI e latência) e
// compensação de latência na gravação de áudio. Toca notas baixas por ~6 s.
//
//   node midi-flow.mjs [pasta-dos-prints] [porta]

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
const midi = (status, data1, data2) => c.evaluate(`window.audio.request('midi.simulate', { status: ${status}, data1: ${data1}, data2: ${data2} })`)
const listen = ms => c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
  let p = 0; const t0 = performance.now()
  while (performance.now() - t0 < ${ms}) { p = Math.max(p, ...engine.meterLevels()); await new Promise(r => setTimeout(r, 30)) }
  return +p.toFixed(4) })`)
const desc = () => c.evaluate(`${P}.history[${P}.historyIndex].desc`)

try {
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`Object.assign(${UI}, { splashOpen: false, pluginEffect: false, effect: null, audioDevicesOpen: false, aboutOpen: false, fxTarget: null, pianoRoll: null, instrumentPicker: null })`)
  await c.evaluate(`${P}.stop(); ${P}.resetProject(); localStorage.setItem('raven.rec.latencyAdjustMs', '0')`)
  await c.sleep(1200)

  // Faixa MIDI selecionada (sintetizador embutido).
  await c.menu('Faixas', 'Nova faixa MIDI')
  await c.sleep(800)
  await c.evaluate(`${UI}.pianoRoll = null; ${P}.setTrackProp(${P}.tracks[0].id, 'gain', -12)`)
  await c.sleep(600)

  // 1. Entrada MIDI toca na faixa selecionada.
  const playNote = async () => { await midi(0x90, 60, 100); const p = await listen(400); await midi(0x80, 60, 0); return p }
  const selected = await playNote()
  check(selected > 0.005, 'entrada MIDI toca na faixa MIDI selecionada', `pico ${selected}`)
  await c.sleep(800)

  // 2. Sem faixa selecionada, não toca.
  await c.evaluate(`${P}.tracks.forEach(t => { t.selected = false })`)
  await c.sleep(600)
  const none = await playNote()
  check(none < 0.001, 'sem faixa MIDI selecionada, a entrada não toca', `pico ${none}`)
  await c.evaluate(`${P}.tracks[0].selected = true`)
  await c.sleep(600)

  // 3. Gravar MIDI com R: dó em ~0,4 s (0,3 s) e mi em ~0,9 s (0,2 s) depois de começar.
  await c.evaluate(`${P}.cursorTo(0); document.activeElement?.blur()`)
  await c.key('r', { code: 'KeyR', keyCode: 82 })
  await c.waitFor(`${P}.recording`, 8000)
  const start = Date.now()
  const at = ms => c.sleep(Math.max(0, start + ms - Date.now()))
  await at(400); await midi(0x90, 60, 100)
  await at(700); await midi(0x80, 60, 0)
  await at(900); await midi(0x90, 64, 90)
  await at(1100); await midi(0x80, 64, 0)
  await at(1500)
  await shot('40-gravando-midi.png')
  await c.key(' ', { code: 'Space', keyCode: 32 })
  await c.waitFor(`!${P}.recording`, 5000)
  await c.sleep(500)
  const notes = await c.evaluate(`${P}.tracks[0].notes.map(n => ({ pitch: n.pitch, start: +n.start.toFixed(3), dur: +n.dur.toFixed(3) }))`)
  const [n1, n2] = notes
  check(notes.length === 2 && n1.pitch === 60 && n2.pitch === 64 && Math.abs(n2.start - n1.start - 0.5) < 0.08 &&
    Math.abs(n1.dur - 0.3) < 0.08, 'gravação MIDI com R vira notas na faixa', JSON.stringify(notes))
  check((await desc()) === 'Gravado MIDI: 2 notas', 'gravação MIDI entra no histórico', await desc())
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 }); await c.sleep(500)
  check((await c.evaluate(`${P}.tracks[0].notes.length`)) === 0, 'desfazer a gravação MIDI')

  // 4. Diálogo de dispositivos: seções MIDI e Gravação.
  await c.menu('Transporte', 'Dispositivos de áudio')
  await c.waitFor(`!!document.querySelector('.devices-card .q-select')`, 15000)
  await c.sleep(600)
  const dialog = await c.evaluate(`document.querySelector('.devices-card').innerText`)
  check(dialog.includes('Entrada MIDI') && dialog.includes('compensação de latência'), 'diálogo com entrada MIDI e ajuste de latência')
  await shot('41-dispositivos-midi.png')
  await c.evaluate(`${UI}.audioDevicesOpen = false`)
  await c.sleep(500)

  // 5. Compensação de latência na gravação de áudio: dois takes de ~1,5 s, um com
  // ajuste de 0 ms e outro de 800 ms; o segundo fica ~0,8 s mais curto.
  const take = async adjustMs => {
    await c.evaluate(`localStorage.setItem('raven.rec.latencyAdjustMs', '${adjustMs}'); (() => { const s = ${P}; s.newTrack(1); s.tracks.forEach((t, i) => { t.selected = i === s.tracks.length - 1 }); s.cursorTo(0); document.activeElement?.blur() })()`)
    await c.sleep(300)
    await c.key('r', { code: 'KeyR', keyCode: 82 })
    await c.waitFor(`${P}.recording`, 8000)
    await c.sleep(1500)
    await c.key(' ', { code: 'Space', keyCode: 32 })
    await c.waitFor(`!${P}.recording`, 5000)
    await c.sleep(300)
    return c.evaluate(`${P}.tracks.at(-1).channels[0].length / ${P}.rate`)
  }
  const plain = await take(0)
  const adjusted = await take(800)
  await c.evaluate(`localStorage.setItem('raven.rec.latencyAdjustMs', '0')`)
  check(Math.abs(plain - adjusted - 0.8) < 0.2, 'ajuste da compensação de latência desloca o take',
    `${plain.toFixed(3)} s sem ajuste, ${adjusted.toFixed(3)} s com 800 ms`)

  const errors = await c.evaluate(`[...document.querySelectorAll('.q-notification')].map(n => n.innerText)`)
  check(!errors.length, 'sem mensagens de erro', errors.join(' | '))
} catch (e) {
  failures++
  console.log('FALHA', e.message)
  await shot('erro.png').catch(() => {})
} finally {
  c.close()
}

console.log(failures ? `\n${failures} verificação(ões) falharam. Prints em ${outDir}` : `\nTudo certo. Prints em ${outDir}`)
process.exit(failures ? 1 : 0)
