---
name: run-raven-desktop
description: Abre e controla o app desktop do Raven Audio Editor (Electron + motor JUCE raven-engine) para testar de verdade a reprodução, a mixagem, os efeitos em tempo real, a gravação e os dispositivos de áudio do motor nativo, plugins VST3/LV2 nas cadeias em tempo real (estado, desfazer, janela nativa, compensação de latência), instrumentos virtuais (VSTi) nas faixas MIDI, entrada e gravação MIDI, compensação de latência da gravação, clipes (dividir, juntar, mover, excluir deixando vão), barramentos e envios, automação de volume/pan (ferramenta de envelope), congelar faixa, exportação em segundo plano, o fluxo Efeito → Plugin (VST3 / LV2)… e a tela Sobre. Use para rodar, testar, tirar prints ou confirmar uma mudança no app desktop, no motor (engine/), no motor de áudio nativo ou no diálogo de plugins.
---

# Rodar e testar o Raven Audio Editor desktop

Testado no Windows 10, Node 24, Electron 45, JUCE 9.0.5, em 18/11/2026.
O app é controlado pelo protocolo de depuração do Chromium (CDP), com o
`WebSocket` nativo do Node. Não precisa de Playwright.

Arquivos desta skill:
- `driver/cdplib.mjs`: clicar, teclar, abrir menus (`c.menu('Faixas', 'Nova faixa estéreo')`,
  com nova tentativa se o clique se perder), avaliar JS na página, tirar print.
- `driver/plugin-flow.mjs`: Efeito → Plugin pela interface, com 9 verificações (Fase 1).
- `driver/transport-flow.mjs`: tocar, mix ao vivo, fim do trecho, gravar com R e
  dispositivos de áudio pela interface, com 8 verificações (Fase 2). Toca um tom baixo.
- `driver/chain-flow.mjs`: plugin numa cadeia em tempo real pela interface (painel →
  Plugin…, parâmetro genérico, histórico, desfazer/refazer, liga/desliga tocando, janela,
  arquivo de projeto), com 8 verificações (Fase 3).
- `driver/instrument-flow.mjs`: instrumento virtual numa faixa MIDI pela interface (seletor
  do cabeçalho, tocar, nota avulsa, MIDI → áudio, desfazer, janela, projeto), 8 verificações (Fase 4).
- `driver/midi-flow.mjs`: entrada MIDI na faixa selecionada, gravação MIDI com R, diálogo
  com MIDI e latência, ajuste da compensação da gravação de áudio, 8 verificações (Fase 4).
- `driver/mix-flow.mjs`: barramento e envio pelo painel, solo seguro, envelope com dois cliques,
  render seguindo a automação, congelar com o botão ❄ (editar descongela, desfazer congela),
  projeto com barramento salvo e aberto, exportação em segundo plano com progresso e
  Cancelar, 16 verificações (Fase 5).
- `driver/clips-flow.mjs`: clipes pela interface (Editar → Dividir clipe, Ctrl+Alt+K, arrastar
  com a ferramenta de mover, duplo clique, Ctrl+J, desfazer, render, duplicar, projeto),
  9 verificações (Fase 5).
- `driver/engine-mix.mjs`: barramentos, envios, solo seguro, PDC através do barramento,
  automação de volume e pan, render em segundo plano (motor livre, progresso, cancelar)
  no motor sozinho, 11 verificações.
- `driver/engine-smoke.mjs`: plugins no motor sozinho (ping, lista, processamento).
- `driver/engine-instrument.mjs`: instrumento na faixa MIDI no motor sozinho (render,
  reprodução, nota avulsa, release ao parar), 7 verificações.
- `driver/engine-midi.mjs`: entrada MIDI simulada (`midi.simulate`), faixa alvo e tempo das
  notas gravadas, 7 verificações.
- `driver/engine-chain.mjs`: plugin em cadeia no motor sozinho (estado, desfazer sem eco,
  render com o estado ao vivo, PDC, janela, plugin ausente), com 11 verificações.
- `driver/engine-audio.mjs`: motor de áudio sozinho: ganho/pan exatos, os 8 efeitos,
  MIDI, e com `--live` reprodução e gravação (25 verificações).

## Pré-requisitos

1. `npm install` na raiz (o `postinstall` roda `quasar prepare`) e em `src-electron/`.
2. Submódulo do JUCE: `git submodule update --init`.
3. Motor compilado: `npm run build:engine` gera `engine/bin/raven-engine.exe`.
   Precisa do Visual Studio 2022 Build Tools (carga "Desenvolvimento para desktop
   com C++") e do CMake 3.22 ou mais novo (testado com o 4.4.4 do winget e com o
   3.31 que vem no Build Tools). **Dev-C++/MinGW não serve.**
4. Plugin **kHs Gain** instalado (Kilohearts Essentials, gratuito). Os cenários
   usam ele porque o resultado é calculável: Gain a 20% do slider dá −18 dB.
5. Instrumento para os testes da Fase 4: **Black Pearl Drumkit** (LV2, AVL Drumkits).
   Ele carrega amostras em segundo plano: espere ~3 s depois de colocá-lo numa faixa.
   Não há teclado MIDI nesta máquina: os testes usam `midi.simulate`.
6. Para o teste de compensação de latência: **MFreeformPhase** (MeldaProduction
   Free Bundle), com 8192 amostras de latência e fase plana por padrão. Sem ele,
   o `engine-chain.mjs` pula esse teste.

## Armadilhas (leia antes)

- **`ELECTRON_RUN_AS_NODE=1`**: o terminal do VS Code/Claude herda essa variável
  e o Electron vira Node puro (`does not provide an export named 'BrowserWindow'`).
  Rode `unset ELECTRON_RUN_AS_NODE` antes de abrir o app.
- **Git Bash converte argumentos com `/`** (`/m` vira `M:/`). Para o MSBuild use
  `cmake --build ... --parallel`, nunca `-- /m`.
- **Motor travado em uso**: com o app aberto, matar o `raven-engine` não adianta,
  porque o `engine-host.js` o reinicia na hora e o arquivo fica travado. A cópia
  para `engine/bin` falha. **Feche o app antes de recompilar o motor.**
- **Janela escondida**: se o app estiver atrás de outra janela ou minimizado, o
  Chromium suspende o `requestAnimationFrame`, e `store.playhead`/`store.levels`
  param de atualizar (o som continua). Para checar o motor, use
  `import('/src/audio/engine.js').then(m => m.engine.position())` no `evaluate`.
- **Teclas no CDP**: letras sem modificador precisam de `keyDown` com `text` (o
  `cdplib.mjs` já faz); com `rawKeyDown` o atalho R não dispara.
- **Primeira gravação** leva ~2 s para começar (o WASAPI reabre o dispositivo para
  ligar a entrada); espere `store.recording` antes de contar o tempo. As seguintes
  começam na hora.
- **Entrada padrão** é a do Windows; nesta máquina é o "CABLE Output (VB-Audio
  Virtual Cable)", que grava silêncio. Para testar som de verdade, escolha o
  microfone em Transporte → Dispositivos de áudio… (ou `audio.setDevice` com `input`).
- **Plugin que imprime no stdout** (FluidSynth) não quebra mais o protocolo, mas
  scripts próprios que leem o stdout do motor devem ignorar linhas que não são JSON
  (`try { JSON.parse(line) } catch {}`).
- **Janela de plugin LV2** (AVL Drumkits) derruba o motor ao ser destruída: o motor só
  a esconde (`keepEditorAlive`). Não "corrija" isso destruindo a janela.
- **Itens no fim de listas longas** (o seletor de instrumento tem 18 opções) ficam fora da
  tela: o `cdplib.mjs` rola o elemento antes de clicar.
- **Depois de escolher num seletor**, o foco fica nele e o Espaço não chega ao atalho:
  `document.activeElement?.blur()` antes de teclar.
- **Comando novo do motor dá "Comando do motor não permitido"**: o processo main
  só aceita uma lista fechada (`ENGINE_COMMANDS` em `src-electron/electron-main.js`).
  Mudar o main reinicia o Electron no `quasar dev`; reabra o app (ver "Encerrar").
- **Tela de abertura e diálogos somem com animação** e engolem o primeiro clique:
  use `c.menu(...)` e espere ~1 s depois de fechá-los.
- **Campo `id` no protocolo**: o `id` de cada pedido sobrescreve campos de mesmo
  nome; por isso clipes usam `clipId`.
- **Modo dev**: o DevTools abre encaixado (a página fica com ~725 px) e também
  aparece como alvo "page" no CDP. O `cdplib.mjs` já escolhe a página do app
  (URL http/file).
- **Mudar o `quasar.config.js` com o `quasar dev` aberto** reinicia o Electron, e
  o novo pode falhar com "address already in use" (porta 5858/9333). Encerre e
  suba de novo (ver "Encerrar").
- **Expressões dentro de `c.evaluate(...)`**: evite `\n`, `\s` e regex em template
  strings, porque a barra invertida se perde. Use `String.fromCharCode(10)`.
- **`import('/src/audio/engine.js')` depois de editar um módulo** (HMR no modo dev) pode
  devolver **outra instância** do motor, e não a do app (que importou a versão com `?t=`):
  `engine.position()` vem nulo. Os medidores (`meterLevels`) vêm de eventos e valem em
  qualquer instância. Para checar posição, reinicie o `quasar dev` ou use `store.playhead`.
- **Objetos do store mandados ao motor** precisam virar objetos simples: o IPC não clona
  os proxies reativos ("An object could not be cloned"). Veja `points()` em `engine-native.js`.
- **Exportar pelo menu até o fim** baixa o arquivo, e o download do Electron pode abrir
  um diálogo nativo de salvar, que o CDP não alcança. O `mix-flow.mjs` cancela a
  exportação antes de terminar; para conferir o áudio, use `engine.render(...)` na página.
- **Arrastar no canvas** precisa de `mousePressed`, vários `mouseMoved` e `mouseReleased`
  (`c.send('Input.dispatchMouseEvent', …)`); o `clickAt` só clica. Duplo clique: o par
  pressionar/soltar com `clickCount: 1` e depois com `clickCount: 2`.
- A tela de abertura cobre os menus: feche com
  `pinia._s.get('ui').splashOpen = false` (o cenário já faz isso).

## Caminho A: app empacotado (testa o instalador e o motor em `resources/`)

```bash
unset ELECTRON_RUN_AS_NODE
npx quasar build -m electron
APP="dist/electron/Packaged/Raven Audio Editor-win32-x64/raven-audio-editor.exe"
("$APP" --remote-debugging-port=9333 > /tmp/raven-app.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -s http://127.0.0.1:9333/json | grep -q index.html && break; done
node .claude/skills/run-raven-desktop/driver/plugin-flow.mjs ./raven-prints 9333
node .claude/skills/run-raven-desktop/driver/transport-flow.mjs ./raven-prints 9333
node .claude/skills/run-raven-desktop/driver/chain-flow.mjs ./raven-prints 9333
node .claude/skills/run-raven-desktop/driver/instrument-flow.mjs ./raven-prints 9333
node .claude/skills/run-raven-desktop/driver/midi-flow.mjs ./raven-prints 9333
node .claude/skills/run-raven-desktop/driver/mix-flow.mjs ./raven-prints 9333
node .claude/skills/run-raven-desktop/driver/clips-flow.mjs ./raven-prints 9333
```

## Caminho B: modo dev (testa o motor em `engine/bin/`)

```bash
unset ELECTRON_RUN_AS_NODE
(npx quasar dev -m electron -- --remote-debugging-port=9333 > /tmp/qdev.log 2>&1 &)
for i in $(seq 1 40); do sleep 2; curl -s http://127.0.0.1:9333/json | grep -q localhost:9300 && break; done
node .claude/skills/run-raven-desktop/driver/plugin-flow.mjs ./raven-prints 9333
```

O que vem depois de `--` no `quasar dev` é repassado ao Electron.

## O que o cenário `plugin-flow.mjs` faz e verifica

1. Fecha a tela de abertura e reinicia o projeto; o motor tem que ser encontrado.
2. Faixas → Nova faixa estéreo, Gerar → Tom → Aplicar, Ctrl+A (pico 0,8).
3. Efeito → Plugin (VST3 / LV2)…: espera a varredura e o carregamento; se o
   plugin aberto não for o kHs Gain, escolhe pela busca do seletor.
4. Bypass e mode são listas; Gain é slider.
5. Clica a 20% do slider do Gain → "−18,07 dB"; Prévia; Interface do plugin
   (abre a janela nativa do motor).
6. Aplicar → pico ≈ 0,0999 nos dois canais **inclusive nos primeiros 10 ms**
   (verifica o pré-rolo do motor); nenhuma notificação de erro.
7. Ctrl+Z volta para 0,8; Ctrl+Y reaplica.

Sai com código 0 quando tudo passa. Prints em `<pasta>/01-dialogo-plugin.png`,
`02-aplicado.png` (e `erro.png` se algo quebrar). **Olhe os prints.**

Para ver a janela nativa do plugin (fica fora da página, o CDP não captura):

```powershell
Get-Process raven-engine | Select-Object Id, MainWindowTitle   # "kHs Gain" enquanto aberta
```

## Motor sem interface

```bash
D="$TEMP/raven-test"; mkdir -p "$D"
export RAVEN_PLUGIN_CACHE="$(cygpath -w "$D/known-plugins.xml")" RAVEN_SCAN_PEDAL="$(cygpath -w "$D/pedal.txt")"
echo '{"id":1,"cmd":"ping"}' | engine/bin/raven-engine.exe           # responde {"id":1,"ok":true,...}
engine/bin/raven-engine.exe --scan > "$D/scan.log"                    # termina com {"event":"scan.done","count":N}
node .claude/skills/run-raven-desktop/driver/engine-smoke.mjs "$(cygpath -w engine/bin/raven-engine.exe)" "$(cygpath -w "$D")"
node .claude/skills/run-raven-desktop/driver/engine-audio.mjs "$(cygpath -w engine/bin/raven-engine.exe)" "$(cygpath -w "$D")" --live
node .claude/skills/run-raven-desktop/driver/engine-chain.mjs "$(cygpath -w engine/bin/raven-engine.exe)" "$(cygpath -w "$D")"
node .claude/skills/run-raven-desktop/driver/engine-instrument.mjs "$(cygpath -w engine/bin/raven-engine.exe)" "$(cygpath -w "$D")"
node .claude/skills/run-raven-desktop/driver/engine-midi.mjs "$(cygpath -w engine/bin/raven-engine.exe)" "$(cygpath -w "$D")"
node .claude/skills/run-raven-desktop/driver/engine-mix.mjs "$(cygpath -w engine/bin/raven-engine.exe)" "$(cygpath -w "$D")"
```

O `engine-smoke.mjs` exige RMS a −18 dB com erro < 0,001 (dá 0,0445 exato).
Avisos `lilv ... Reloading plugin` no stderr da varredura são inofensivos.

## Paridade com o motor Web Audio (modo dev)

No modo dev, a página importa os módulos pelo Vite, então dá para renderizar o
mesmo projeto nos dois motores e comparar:

```js
const { engine, webEngine } = await import('/src/audio/engine.js')
const args = { tracks, rate: 44100, t0: 0, t1: 2, master: { gain: 0, effects: [] }, channels: 2 }
const [web, nativo] = [await webEngine.render(args), await engine.render(args)]
```

Resultado em 18/11/2026: 0 dB de diferença em ganho/pan, Graves e Agudos, filtros,
distorção e MIDI; eco e reverb batem com ruído (com tons puros, o eco difere pelo
atraso extra de 128 amostras do Chromium e o reverb pela resposta ao impulso
aleatória). Detalhes na seção 4.6 de docs/INTEGRACAO-PLUGINS-NATIVOS.md.

## Tela Sobre (licenças)

Ajuda → Sobre: versão + commit do build, link "Código-fonte desta versão"
(`/tree/<commit>` no GitHub), 41 componentes de terceiros em 3 grupos.
Não clique nos links no teste: eles abrem o navegador do sistema.

## Encerrar

```powershell
# app empacotado
taskkill /IM raven-audio-editor.exe /F
# modo dev: só os processos deste projeto (não mate todo node.exe)
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -and $_.CommandLine -match 'dev-electron') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'quasar\S* dev') -or $_.Name -eq 'raven-engine.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
