// Cenário de teste do fluxo Efeito → Plugin (VST3 / LV2)… no app desktop.
// Usa o app já aberto com --remote-debugging-port (ver SKILL.md).
//
//   node plugin-flow.mjs [pasta-dos-prints] [porta]
//
// Precisa do plugin "kHs Gain" (Kilohearts Essentials, gratuito) instalado.
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
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
// Picos por canal: nos primeiros 10 ms e no trecho todo.
const peaks = () => c.evaluate(`${store('project')}.tracks[0].channels.map(ch => {
  let head = 0, all = 0; const n10 = Math.round(ch.length / 500)
  for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (i < n10) head = Math.max(head, v); all = Math.max(all, v) }
  return { inicio: +head.toFixed(4), total: +all.toFixed(4) } })`)
const dialogText = () => c.evaluate(`document.querySelector('.plugin-card .text-h6')?.innerText ?? null`)

try {
  // 1. Estado limpo
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`${store('ui')}.splashOpen = false`)
  await c.evaluate(`${store('project')}.resetProject()`)
  await c.sleep(500)
  const engine = await c.evaluate('window.audio?.engineStatus()')
  check(engine?.available, 'motor encontrado', engine?.binary)

  // 2. Faixa estéreo com um tom de 5 s, tudo selecionado
  await c.clickText('Faixas', '.menu-bar .q-btn'); await c.sleep(400)
  await c.clickText('Nova faixa estéreo', '.q-menu .q-item'); await c.sleep(600)
  await c.clickText('Gerar', '.menu-bar .q-btn'); await c.sleep(400)
  await c.clickText('Tom', '.q-menu .q-item'); await c.sleep(700)
  await c.clickText('Aplicar', '.effect-card button'); await c.sleep(1200)
  await c.key('a', { ctrl: true, code: 'KeyA', keyCode: 65 }); await c.sleep(400)
  const before = await peaks()
  check(before.length === 2 && before.every(p => p.total === 0.8), 'tom estéreo gerado', JSON.stringify(before))

  // 3. Diálogo do plugin (espera a varredura e o carregamento do último plugin)
  await c.clickText('Efeito', '.menu-bar .q-btn'); await c.sleep(400)
  await c.clickText('Plugin (VST3', '.q-menu .q-item')
  await c.waitFor(`!!document.querySelector('.plugin-card') && !document.querySelector('.plugin-card .q-linear-progress') && !document.querySelector('.q-loading')`, 300000)
  await c.sleep(1500)
  if (await dialogText() !== 'kHs Gain') {
    const field = await c.evaluate(`(() => { const r = document.querySelector('.plugin-card .q-field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await c.clickAt(field.x, field.y); await c.sleep(400)
    await c.type('kHs Gain'); await c.sleep(600)
    await c.clickText('kHs Gain', '.q-menu .q-item')
    await c.waitFor(`document.querySelector('.plugin-card .text-h6')?.innerText === 'kHs Gain' && !document.querySelector('.q-loading')`, 30000)
    await c.sleep(500)
  }
  check(await dialogText() === 'kHs Gain', 'kHs Gain carregado')
  const controls = await c.evaluate(`Object.fromEntries([...document.querySelectorAll('.plugin-card .param-list > div')].map(d =>
    [d.innerText.split(String.fromCharCode(10))[0], d.querySelector('.q-select') ? 'lista' : d.querySelector('.q-toggle') ? 'liga/desliga' : 'slider']))`)
  check(controls.Gain === 'slider' && controls.mode === 'lista', 'tipos dos controles', JSON.stringify(controls))

  // 4. Gain a 20% do slider (≈ −18 dB), prévia e janela nativa
  // O overlay "Processando…" some com animação depois de carregar o plugin e
  // bloqueia cliques: espera ele sair e repete o clique se o valor não mudar.
  // O plugin formata com sinal "−" (U+2212) e espaço não separável antes de "dB".
  const minus18 = /[-−]1[78][.,]\d+\s*dB/
  let gainText = ''
  for (let attempt = 0; attempt < 3 && !minus18.test(gainText); attempt++) {
    await c.waitFor(`!document.querySelector('.q-loading')`, 30000); await c.sleep(800)
    const slider = await c.evaluate(`(() => { const row = [...document.querySelectorAll('.plugin-card .param-list > div')].find(d => d.innerText.startsWith('Gain'));
      const r = row.querySelector('.q-slider').getBoundingClientRect(); return { x: r.x + r.width * 0.2, y: r.y + r.height / 2 } })()`)
    await c.clickAt(slider.x, slider.y); await c.sleep(800)
    gainText = await c.evaluate(`[...document.querySelectorAll('.plugin-card .param-list > div')].find(d => d.innerText.startsWith('Gain')).innerText.split(String.fromCharCode(10)).join(' ')`)
  }
  check(minus18.test(gainText), 'Gain ajustado', gainText)
  await c.clickText('Prévia', '.plugin-card button'); await c.sleep(1500)
  await c.clickText('Interface do plugin', '.plugin-card button'); await c.sleep(2000)
  await shot('01-dialogo-plugin.png')

  // 5. Aplicar: o trecho inteiro, desde o primeiro milissegundo, a ≈ −18 dB
  await c.clickText('Aplicar', '.plugin-card button')
  await c.waitFor(`!document.querySelector('.plugin-card')`, 60000); await c.sleep(800)
  const after = await peaks()
  check(after.every(p => p.inicio > 0.09 && p.inicio < 0.11 && p.total > 0.09 && p.total < 0.11), 'aplicado a −18 dB em todo o trecho', JSON.stringify(after))
  const notes = await c.evaluate(`[...document.querySelectorAll('.q-notification')].map(n => n.innerText)`)
  check(!notes.length, 'sem mensagens de erro', notes.join(' | '))
  await shot('02-aplicado.png')

  // 6. Desfazer e refazer
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 }); await c.sleep(800)
  check((await peaks()).every(p => p.total === 0.8), 'Ctrl+Z restaura o original')
  await c.key('y', { ctrl: true, code: 'KeyY', keyCode: 89 }); await c.sleep(800)
  check((await peaks()).every(p => p.total < 0.11), 'Ctrl+Y reaplica')
} catch (e) {
  failures++
  console.log('FALHA', e.message)
  await shot('erro.png').catch(() => {})
} finally {
  c.close()
}

console.log(failures ? `\n${failures} verificação(ões) falharam. Prints em ${outDir}` : `\nTudo certo. Prints em ${outDir}`)
process.exit(failures ? 1 : 0)
