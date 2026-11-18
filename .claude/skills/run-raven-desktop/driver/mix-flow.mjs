// Cenário da Fase 5 pela interface: barramento e envio (Faixas → Novo barramento,
// painel de efeitos → Adicionar envio), automação com a ferramenta de envelope
// (F3), congelar faixa (botão ❄ do cabeçalho), projeto com barramento salvo e
// aberto, e exportação em segundo plano (aviso com progresso, app livre, Cancelar).
// Toca um tom baixo por alguns segundos.
//
//   node mix-flow.mjs [pasta-dos-prints] [porta]

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
// Pico na saída do motor durante `ms` tocando do começo.
const listen = async ms => {
  await c.evaluate(`${P}.stop(); ${P}.play({ t0: 0.2, t1: 3, isSelection: false })`)
  await c.sleep(300)
  const peak = await c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
    let p = 0; const t0 = performance.now()
    while (performance.now() - t0 < ${ms}) { p = Math.max(p, ...engine.meterLevels()); await new Promise(r => setTimeout(r, 30)) }
    return +p.toFixed(4) })`)
  await c.evaluate(`${P}.stop()`)
  await c.sleep(200)
  return peak
}
const canvasOf = id => c.evaluate(`(() => { const r = document.querySelector('[data-track-id="${id}"] canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)

try {
  await c.waitFor(`!!document.querySelector('.menu-bar')`, 60000)
  await c.sleep(1500)
  await c.evaluate(`Object.assign(${UI}, { splashOpen: false, pluginEffect: false, effect: null, audioDevicesOpen: false, aboutOpen: false, fxTarget: null, pianoRoll: null, instrumentPicker: null, mixerOpen: false })`)
  await c.evaluate(`${P}.stop(); ${P}.resetProject(); ${P}.tool = 'select'`)
  await c.sleep(1000)

  // Faixa estéreo com um tom de 440 Hz, amplitude 0,2, 3 s.
  const trackId = await c.evaluate(`(() => {
    const s = ${P}; const n = s.rate * 3
    const ch = new Float32Array(n).map((_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / s.rate))
    const t = s.addTrack({ name: 'Tom', channels: [ch, ch.slice()], selected: true })
    s.pushState('Tom de teste'); s.zoomFit(); return t.id })()`)
  await c.sleep(500)
  const plain = await listen(700)

  // 1. Faixas → Novo barramento: o painel abre no barramento.
  await c.menu('Faixas', 'Novo barramento')
  await c.sleep(800)
  const bus = await c.evaluate(`(() => { const b = ${P}.buses[0]; return b && { id: b.id, name: b.name, panel: ${UI}.fxTarget === b.id } })()`)
  check(!!bus && bus.panel && (await desc()) === 'Novo barramento', 'Faixas → Novo barramento cria o barramento e abre o painel dele', bus?.name)

  // 2. Painel da faixa → Adicionar envio → barramento.
  await c.evaluate(`${UI}.fxTarget = ${trackId}`)
  await c.sleep(600)
  await c.clickText('Adicionar envio', '.q-btn')
  await c.sleep(500)
  await c.clickText(bus.name, '.q-menu .q-item')
  await c.sleep(600)
  const sends = await c.evaluate(`JSON.stringify(${P}.findTrack(${trackId}).sends)`)
  check(sends === JSON.stringify([{ bus: bus.id, level: -6 }]), 'envio criado pelo painel, a -6 dB', sends)
  await shot('50-envio.png')

  // 3. O envio soma no som: tom + metade dele pelo barramento (pós-fader).
  const withSend = await listen(700)
  check(Math.abs(withSend / plain - 1.5) < 0.05, 'o barramento soma o envio na saída', `${plain} sem envio, ${withSend} com envio (${(withSend / plain).toFixed(2)}×)`)

  // 4. Solo da faixa não cala o barramento (solo seguro).
  await c.evaluate(`${P}.setTrackProp(${trackId}, 'solo', true)`)
  const soloed = await listen(700)
  await c.evaluate(`${P}.setTrackProp(${trackId}, 'solo', false)`)
  check(Math.abs(soloed / withSend - 1) < 0.05, 'solo na faixa mantém o barramento tocando', `${soloed}`)
  await c.evaluate(`${UI}.fxTarget = null`)
  await c.sleep(500)

  // 5. Ferramenta de envelope (botão da barra), dois cliques no canvas da faixa:
  // ponto em 0 dB no começo e outro no fim, lá embaixo.
  const envBtn = await c.evaluate(`(() => { const r = document.querySelector('button[title^="Envelope"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await c.clickAt(envBtn.x, envBtn.y)
  await c.sleep(300)
  check((await c.evaluate(`${P}.tool`)) === 'envelope', 'botão da ferramenta de envelope')
  const cv = await canvasOf(trackId)
  const xAt = t => c.evaluate(`(${t} - ${P}.scrollTime) * ${P}.pps`).then(x => cv.x + x)
  await c.clickAt(await xAt(0.5), cv.y + cv.h / 2)
  await c.sleep(300)
  await c.clickAt(await xAt(2.5), cv.y + cv.h - 6)
  await c.sleep(500)
  const lane = await c.evaluate(`${P}.findTrack(${trackId}).automation.gain.map(p => [+p.t.toFixed(2), +p.v.toFixed(1)])`)
  check(lane.length === 2 && lane[0][1] === 0 && lane[1][1] < -30 && Math.abs(lane[1][0] - 2.5) < 0.1,
    'envelope de volume criado com dois cliques', JSON.stringify(lane))
  check((await desc()) === 'Automação de volume alterada', 'automação entra no histórico')
  await shot('51-envelope.png')

  // 6. O render (mesmo caminho da exportação) segue o envelope.
  const levels = await c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
    const s = ${P}
    const [l] = await engine.render({ tracks: s.engineTracks, rate: s.rate, t0: 0, t1: 3, master: s.master, channels: 2 })
    const peak = (a, b) => { let p = 0; for (let i = Math.round(a * s.rate); i < Math.round(b * s.rate); i++) p = Math.max(p, Math.abs(l[i])); return +p.toFixed(4) }
    return [peak(0.1, 0.4), peak(2.6, 2.9)] })`)
  check(Math.abs(levels[0] - 0.3) < 0.02 && levels[1] < 0.3 * 0.05, 'render segue a automação de volume', `${levels[0]} antes, ${levels[1]} depois da rampa`)

  // 7. Desfazer tira o segundo ponto; F1 volta à seleção.
  await c.evaluate(`document.activeElement?.blur()`)
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 })
  await c.sleep(400)
  check((await c.evaluate(`${P}.findTrack(${trackId}).automation.gain.length`)) === 1, 'desfazer a automação')
  await c.evaluate(`${P}.clearAutomation(${trackId}, 'gain'); ${P}.tool = 'select'`)

  // 8. Congelar uma faixa MIDI pelo botão ❄ do cabeçalho.
  const midiId = await c.evaluate(`(() => {
    const s = ${P}
    const t = s.addTrack({ kind: 'midi', name: 'Teclado', notes: [60, 64, 67].map((pitch, i) => ({ id: 'n' + i, pitch, start: i * 0.3, dur: 0.6, vel: 100 })), program: 0 })
    s.pushState('Faixa MIDI de teste'); return t.id })()`)
  await c.sleep(600)
  const snow = await c.evaluate(`(() => { const r = document.querySelector('[data-track-id="${midiId}"] button[title^="Congelar"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await c.clickAt(snow.x, snow.y)
  await c.waitFor(`${P}.history[${P}.historyIndex].desc.startsWith('Faixa congelada')`, 20000)
  const frozen = await c.evaluate(`(() => { const v = ${P}.engineTracks.find(t => t.id === ${midiId}); return { kind: v.kind, len: v.channels[0].length / ${P}.rate, effects: v.effects.length } })()`)
  check(frozen.kind === 'audio' && frozen.len > 2.5 && frozen.effects === 0, 'faixa MIDI congelada vira áudio para o motor', JSON.stringify(frozen))
  await shot('52-congelada.png')
  await c.evaluate(`${P}.setTrackProp(${trackId}, 'mute', true)`)
  const frozenPeak = await listen(700)
  check(frozenPeak > 0.01, 'faixa congelada toca', `pico ${frozenPeak}`)
  await c.evaluate(`${P}.setTrackProp(${trackId}, 'mute', false)`)

  // 9. Editar as notas descongela; desfazer volta ao congelado.
  await c.evaluate(`(() => { const s = ${P}; const t = s.findTrack(${midiId}); s.setTrackNotes(t.id, t.notes.slice(1), 'Nota apagada') })()`)
  const afterEdit = await c.evaluate(`${P}.engineTracks.find(t => t.id === ${midiId}).kind`)
  await c.key('z', { ctrl: true, code: 'KeyZ', keyCode: 90 })
  await c.sleep(400)
  const afterUndo = await c.evaluate(`${P}.engineTracks.find(t => t.id === ${midiId}).kind`)
  check(afterEdit === 'midi' && afterUndo === 'audio', 'editar descongela, desfazer congela de novo', `${afterEdit} → ${afterUndo}`)

  // 10. Projeto salvo e aberto: barramento e envio continuam ligados.
  const reopened = await c.evaluate(`import('/src/audio/fileio.js').then(async ({ encodeProject }) => {
    const s = ${P}
    await s.openProject(new File([encodeProject(s)], 'teste.ravenproj'))
    const t = s.tracks.find(x => x.name === 'Tom'); const b = s.buses[0]
    return { sends: t.sends.map(x => x.bus === b.id && x.level), buses: s.buses.length } })`)
  check(reopened.buses === 1 && reopened.sends[0] === -6, 'projeto salvo e aberto mantém barramento e envio', JSON.stringify(reopened))

  // 11. Exportação em segundo plano: projeto longo (2 min com reverb no master),
  // aviso com progresso, tocar continua funcionando, e Cancelar.
  await c.evaluate(`(() => {
    const s = ${P}; const n = s.rate * 120
    const ch = new Float32Array(n).map((_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / s.rate))
    s.addTrack({ name: 'Longa', channels: [ch] })
    s.addRealtimeEffect('master', 'reverb'); s.addRealtimeEffect('master', 'reverb')
    s.master.effects = s.master.effects.map(e => ({ ...e, params: { ...e.params, time: 10 } }))
    s.pushState('Projeto longo') })()`)
  await c.sleep(800)
  await c.menu('Arquivo', 'Exportar como WAV 16-bit')
  await c.waitFor(`[...document.querySelectorAll('.q-notification')].some(n => n.innerText.includes('Exportando'))`, 15000)
  await c.sleep(1500)
  const progressText = await c.evaluate(`[...document.querySelectorAll('.q-notification')].map(n => n.innerText).join(' | ')`)
  await shot('53-exportando.png')
  // Os medidores vêm de eventos do motor; a posição não serve aqui, porque depois
  // de um HMR o import() do cenário pode pegar outra instância do módulo.
  await c.evaluate(`${P}.play({ t0: 0, t1: 30, isSelection: false })`)
  await c.sleep(400)
  const playingPeak = await c.evaluate(`import('/src/audio/engine.js').then(async ({ engine }) => {
    let p = 0; const t0 = performance.now()
    while (performance.now() - t0 < 800) { p = Math.max(p, ...engine.meterLevels()); await new Promise(r => setTimeout(r, 30)) }
    return +p.toFixed(4) })`)
  await c.evaluate(`${P}.stop()`)
  const shown = progressText.split(String.fromCharCode(10)).join(' ')
  check(/\d+%/.test(progressText) && playingPeak > 0.05, 'exportação mostra o progresso e o app continua tocando', `"${shown}", pico tocando ${playingPeak}`)
  await c.clickText('Cancelar', '.q-notification .q-btn')
  await c.waitFor(`[...document.querySelectorAll('.q-notification')].some(n => n.innerText.includes('Exportação cancelada'))`, 10000)
  check(true, 'Cancelar interrompe a exportação')
  await c.sleep(3000)

  const errors = await c.evaluate(`[...document.querySelectorAll('.q-notification')].map(n => n.innerText).filter(t => !t.includes('Exportação'))`)
  check(!errors.length, 'sem mensagens de erro', errors.join(' | '))
} catch (e) {
  failures++
  console.log('FALHA', e.message)
  await shot('erro.png').catch(() => {})
} finally {
  await c.evaluate(`${P}.stop()`).catch(() => {})
  c.close()
}

console.log(failures ? `\n${failures} verificação(ões) falharam. Prints em ${outDir}` : `\nTudo certo. Prints em ${outDir}`)
process.exit(failures ? 1 : 0)
