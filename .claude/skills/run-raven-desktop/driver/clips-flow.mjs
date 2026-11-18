// Cenário dos clips (Fase 5) pela interface: Editar → Dividir clipe, Excluir
// deixando vão (Ctrl+Alt+K), arrastar um clipe com a ferramenta de mover, duplo
// clique seleciona o clipe, Juntar clipes (Ctrl+J), desfazer, o motor tocando o
// que se vê, duplicar e projeto salvo/aberto com os clipes.
//
//   node clips-flow.mjs [pasta-dos-prints] [porta]

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
const desc = () => c.evaluate(`${P}.history[${P}.historyIndex].desc`)
// Clipes da faixa em segundos do projeto, com 2 casas.
const clipsOf = id => c.evaluate(`(() => { const s = ${P}; const t = s.findTrack(${id}); return t.clips.map(x => [+(t.offset + x.s0 / s.rate).toFixed(2), +(t.offset + x.s1 / s.rate).toFixed(2)]) })()`)
const canvasOf = id => c.evaluate(`(() => { const r = document.querySelector('[data-track-id="${id}"] canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
const mouse = (type, x, y, clickCount = 1) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount })

try {
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`Object.assign(${UI}, { splashOpen: false, pluginEffect: false, effect: null, audioDevicesOpen: false, aboutOpen: false, fxTarget: null, pianoRoll: null, instrumentPicker: null, mixerOpen: false })`)
  await c.evaluate(`${P}.stop(); ${P}.resetProject(); ${P}.tool = 'select'`)
  await c.sleep(1000)

  // Faixa mono com um tom de 3 s (amplitude 0,2).
  const id = await c.evaluate(`(() => {
    const s = ${P}; const n = s.rate * 3
    const ch = new Float32Array(n).map((_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / s.rate))
    const t = s.addTrack({ name: 'Tom', channels: [ch], selected: true })
    s.pushState('Tom de teste'); s.zoomFit(); return t.id })()`)
  await c.sleep(500)
  check(JSON.stringify(await clipsOf(id)) === '[[0,3]]', 'faixa nova é um clipe só')

  // 1. Editar → Dividir clipe no cursor em 1 s.
  await c.evaluate(`${P}.selectTrack(${id}); ${P}.cursorTo(1)`)
  await c.menu('Editar', 'Dividir clipe')
  await c.sleep(400)
  check(JSON.stringify(await clipsOf(id)) === '[[0,1],[1,3]]' && (await desc()) === 'Dividir clipe', 'Editar → Dividir clipe', JSON.stringify(await clipsOf(id)))

  // 2. Excluir deixando vão (Ctrl+Alt+K) em [1,5; 2]: o resto não anda.
  await c.evaluate(`${P}.setSelection(1.5, 2); document.activeElement?.blur()`)
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', modifiers: 3, windowsVirtualKeyCode: 75 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 3, windowsVirtualKeyCode: 75 })
  await c.sleep(400)
  const gap = await c.evaluate(`(() => { const s = ${P}; const t = s.findTrack(${id}); return Math.abs(t.channels[0][Math.round((1.75 - t.offset) * s.rate)]) })()`)
  check(JSON.stringify(await clipsOf(id)) === '[[0,1],[1,1.5],[2,3]]' && gap === 0, 'Excluir deixando vão (Ctrl+Alt+K)', `${JSON.stringify(await clipsOf(id))}, amostra no vão ${gap}`)

  // 3. Ferramenta de mover: arrastar o último clipe 0,5 s para a direita.
  await c.evaluate(`${P}.tool = 'shift'; ${P}.setSelection(0, 0)`)
  const cv = await canvasOf(id)
  const xAt = t => c.evaluate(`(${t} - ${P}.scrollTime) * ${P}.pps`).then(x => cv.x + x)
  const y = cv.y + cv.h / 2
  const from = await xAt(2.5)
  const to = await xAt(3.0)
  await mouse('mouseMoved', from, y)
  await mouse('mousePressed', from, y)
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', from + ((to - from) * i) / 10, y)
  await shot('60-arrastando-clipe.png')
  await mouse('mouseReleased', to, y)
  await c.sleep(500)
  const moved = await clipsOf(id)
  check(moved.length === 3 && Math.abs(moved[2][0] - 2.5) < 0.03 && Math.abs(moved[2][1] - 3.5) < 0.03 && (await desc()) === 'Clipe movido',
    'arrastar um clipe com a ferramenta de mover', JSON.stringify(moved))

  // 4. Duplo clique no segundo clipe (ferramenta de seleção) seleciona o clipe.
  await c.evaluate(`${P}.tool = 'select'`)
  const mid = await xAt(1.25)
  await mouse('mousePressed', mid, y, 1); await mouse('mouseReleased', mid, y, 1)
  await mouse('mousePressed', mid, y, 2); await mouse('mouseReleased', mid, y, 2)
  await c.sleep(300)
  const sel = await c.evaluate(`[+${P}.sel.t0.toFixed(2), +${P}.sel.t1.toFixed(2)]`)
  check(sel[0] === 1 && sel[1] === 1.5, 'duplo clique seleciona o clipe', JSON.stringify(sel))
  await shot('61-clipes.png')

  // 5. O motor toca o que se vê: silêncio no vão, tom no clipe movido.
  const levels = await c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
    const s = ${P}
    const [l] = await engine.render({ tracks: s.engineTracks, rate: s.rate, t0: 0, t1: 3.5, master: s.master, channels: 2 })
    const peak = (a, b) => { let p = 0; for (let i = Math.round(a * s.rate); i < Math.round(b * s.rate); i++) p = Math.max(p, Math.abs(l[i])); return +p.toFixed(3) }
    return [peak(1.6, 1.9), peak(2.05, 2.45), peak(2.6, 3.4)] })`)
  check(levels[0] === 0 && levels[1] === 0 && Math.abs(levels[2] - 0.2) < 0.01, 'render: vãos em silêncio, clipe movido tocando', JSON.stringify(levels))

  // 6. Juntar clipes (Ctrl+J) numa seleção que pega os dois primeiros; desfazer.
  await c.evaluate(`${P}.setSelection(0.5, 1.2); document.activeElement?.blur()`)
  await c.key('j', { ctrl: true, code: 'KeyJ', keyCode: 74 })
  await c.sleep(400)
  const joined = await clipsOf(id)
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 })
  await c.sleep(400)
  const undone = await clipsOf(id)
  check(JSON.stringify(joined) === '[[0,1.5],[2.5,3.5]]' && undone.length === 3, 'Juntar clipes (Ctrl+J) e desfazer', `${JSON.stringify(joined)} → ${undone.length} clipes`)

  // 7. Duplicar a faixa mantém os clipes; projeto salvo e aberto também.
  await c.evaluate(`${P}.selectTrack(${id}); ${P}.setSelection(0, 0); document.activeElement?.blur()`)
  await c.key('d', { ctrl: true, code: 'KeyD', keyCode: 68 })
  await c.sleep(400)
  const copy = await c.evaluate(`${P}.tracks.at(-1).clips.length`)
  const reopened = await c.evaluate(`import('/src/audio/fileio.js').then(async ({ encodeProject }) => {
    const s = ${P}
    await s.openProject(new File([encodeProject(s)], 'clipes.ravenproj'))
    const t = s.tracks[0]
    return t.clips.map(x => [+(t.offset + x.s0 / s.rate).toFixed(2), +(t.offset + x.s1 / s.rate).toFixed(2)]) })`)
  check(copy === 3 && JSON.stringify(reopened) === JSON.stringify(undone), 'duplicar e salvar/abrir mantêm os clipes', `${copy} clipes na cópia; aberto ${JSON.stringify(reopened)}`)

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
