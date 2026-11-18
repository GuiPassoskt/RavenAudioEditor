// Driver mínimo via Chrome DevTools Protocol para o app Electron.
import { writeFileSync } from 'node:fs'

export async function connect (port = 9333) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find(t => t.type === 'page' && /^(http|file):/.test(t.url))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }))
  })

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  // Centro do elemento visível cujo texto contém `text` (dentro de `scope`, opcional).
  const findByText = (text, selector = '*') => evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => {
      const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.textContent.includes(${JSON.stringify(text)})
    })
    els.sort((a, b) => a.textContent.length - b.textContent.length)
    const e = els[0]; if (!e) return null
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }
  })()`)
  const clickAt = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
  }
  const clickText = async (text, selector) => {
    const p = await findByText(text, selector)
    if (!p) throw new Error(`não encontrei "${text}"`)
    await clickAt(p.x, p.y)
    return p
  }
  // Letras sem modificador precisam de "keyDown" com o texto; Ctrl+tecla e teclas
  // especiais (Espaço, Delete…) vão como "rawKeyDown".
  const key = async (keyName, { ctrl = false, code, keyCode } = {}) => {
    const modifiers = ctrl ? 2 : 0
    const base = { key: keyName, code: code ?? keyName, modifiers, windowsVirtualKeyCode: keyCode }
    const printable = !ctrl && keyName.length === 1 && keyName !== ' '
    await send('Input.dispatchKeyEvent', printable ? { type: 'keyDown', text: keyName, ...base } : { type: 'rawKeyDown', ...base })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  const type = text => send('Input.insertText', { text })
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
  const waitFor = async (expr, timeout = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const v = await evaluate(expr).catch(() => null)
      if (v) return v
      await sleep(250)
    }
    throw new Error(`timeout esperando: ${expr}`)
  }
  // Abre um menu da barra e clica num item; tenta de novo se o clique se perder
  // (animações de diálogos que acabaram de fechar engolem o primeiro clique).
  const menu = async (menuLabel, itemLabel) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await clickText(menuLabel, '.menu-bar .q-btn')
      await sleep(400)
      if (await findByText(itemLabel, '.q-menu .q-item')) {
        await clickText(itemLabel, '.q-menu .q-item')
        return
      }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(500)
    }
    throw new Error(`não consegui abrir ${menuLabel} → ${itemLabel}`)
  }
  return { send, evaluate, sleep, findByText, clickAt, clickText, key, type, shot, waitFor, menu, close: () => ws.close() }
}
