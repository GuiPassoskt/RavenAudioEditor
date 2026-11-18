// Cenário da Fase 2 (motor de áudio nativo) pela interface: motor em uso, tocar
// com Espaço, mudar o mix tocando (sem reiniciar), parar no fim, gravar com R e
// o diálogo de dispositivos. Toca um tom a −24 dB por ~2 s.
//
//   node transport-flow.mjs [pasta-dos-prints] [porta]
//
// Sai com código 1 se alguma verificação falhar.

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
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

try {
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`Object.assign(${store('ui')}, { splashOpen: false, pluginEffect: false, effect: null, audioDevicesOpen: false, aboutOpen: false })`)
  await c.evaluate(`${P}.stop(); ${P}.resetProject()`)
  await c.sleep(500)

  const kind = await c.evaluate(`import('/src/audio/engine.js').then(m => m.engineReady)`).catch(() => null)
  check(kind === 'native', 'motor de áudio nativo em uso', String(kind))

  // Faixa estéreo com tom de 5 s a −24 dB.
  await c.clickText('Faixas', '.menu-bar .q-btn'); await c.sleep(400)
  await c.clickText('Nova faixa estéreo', '.q-menu .q-item'); await c.sleep(600)
  await c.clickText('Gerar', '.menu-bar .q-btn'); await c.sleep(400)
  await c.clickText('Tom', '.q-menu .q-item'); await c.sleep(700)
  await c.clickText('Aplicar', '.effect-card button'); await c.sleep(1200)
  await c.evaluate(`${P}.setTrackProp(${P}.tracks[0].id, 'gain', -24); ${P}.selectNone(); ${P}.cursorTo(0)`)

  // Tocar com Espaço; no meio, o ganho cai 12 dB sem reiniciar a reprodução.
  await c.key(' ', { code: 'Space', keyCode: 32 })
  const samples = []
  for (let i = 0; i < 12; i++) {
    await c.sleep(150)
    samples.push(await c.evaluate(`({ playing: ${P}.playing, head: ${P}.playhead, level: Math.max(...${P}.levels.play) })`))
    if (i === 5) await c.evaluate(`${P}.setTrackProp(${P}.tracks[0].id, 'gain', -36)`)
  }
  const heads = samples.map(s => s.head)
  check(samples.every(s => s.playing) && heads.every((h, i) => i === 0 || h > heads[i - 1]), 'reprodução contínua (posição sempre avança)',
    heads.map(h => h?.toFixed(2)).join(' '))
  const before = samples[4].level
  const after = samples[10].level
  check(before > 0.02 && Math.abs(20 * Math.log10(after / before) + 12) < 1, 'mudança de ganho ao vivo (−12 dB)',
    `${before.toFixed(4)} -> ${after.toFixed(4)}`)
  await shot('10-tocando.png')
  await c.evaluate(`${P}.stop(); ${P}.cursorTo(4.5)`)
  await c.key(' ', { code: 'Space', keyCode: 32 })
  await c.waitFor(`!${P}.playing`, 5000).then(() => check(true, 'para sozinho no fim')).catch(() => check(false, 'para sozinho no fim'))

  // Gravar com R numa faixa mono nova (a primeira abertura da entrada leva ~2 s).
  await c.evaluate(`(() => { const s = ${P}; s.newTrack(1); s.tracks.forEach((t, i) => { t.selected = i === s.tracks.length - 1 }); s.cursorTo(0) })()`)
  await c.sleep(300)
  await c.key('r', { code: 'KeyR', keyCode: 82 })
  await c.waitFor(`${P}.recording`, 8000)
  const startedAt = Date.now()
  await c.sleep(1500)
  await shot('11-gravando.png')
  await c.key(' ', { code: 'Space', keyCode: 32 })
  await c.waitFor(`!${P}.recording`, 5000)
  const elapsed = (Date.now() - startedAt) / 1000
  await c.sleep(300)
  const take = await c.evaluate(`(() => { const t = ${P}.tracks.at(-1); return { seconds: t.channels[0].length / ${P}.rate, label: ${P}.history[${P}.historyIndex]?.desc } })()`)
  check(Math.abs(take.seconds - elapsed) < 0.4 && take.label === 'Gravado áudio', 'gravação com R e Espaço',
    `${take.seconds.toFixed(2)} s gravados em ~${elapsed.toFixed(2)} s`)

  // Segunda gravação: a entrada já está aberta, começa na hora.
  await c.evaluate(`${P}.cursorTo(0)`)
  const t0 = Date.now()
  await c.key('r', { code: 'KeyR', keyCode: 82 })
  await c.waitFor(`${P}.recording`, 8000)
  const startDelay = Date.now() - t0
  await c.sleep(500)
  await c.key(' ', { code: 'Space', keyCode: 32 })
  await c.waitFor(`!${P}.recording`, 5000)
  check(startDelay < 500, 'segunda gravação começa na hora', `${startDelay} ms`)

  const notes = await c.evaluate(`[...document.querySelectorAll('.q-notification')].map(n => n.innerText)`)
  check(!notes.length, 'sem mensagens de erro', notes.join(' | '))

  // Diálogo de dispositivos.
  await c.clickText('Transporte', '.menu-bar .q-btn'); await c.sleep(400)
  await c.clickText('Dispositivos de áudio', '.q-menu .q-item')
  await c.waitFor(`!!document.querySelector('.devices-card .q-select')`, 15000)
  const dialog = await c.evaluate(`document.querySelector('.devices-card').innerText`)
  check(/Em uso: .+ Hz/.test(dialog), 'diálogo de dispositivos', dialog.split(String.fromCharCode(10))[2])
  await shot('12-dispositivos.png')
  await c.evaluate(`${store('ui')}.audioDevicesOpen = false`)
} catch (e) {
  failures++
  console.log('FALHA', e.message)
  await shot('erro.png').catch(() => {})
} finally {
  c.close()
}

console.log(failures ? `\n${failures} verificação(ões) falharam. Prints em ${outDir}` : `\nTudo certo. Prints em ${outDir}`)
process.exit(failures ? 1 : 0)
