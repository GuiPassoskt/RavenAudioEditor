---
name: run-raven-desktop
description: Abre e controla o app desktop do Raven Audio Editor (Electron + motor JUCE raven-engine) para testar de verdade o fluxo Efeito → Plugin (VST3 / LV2)…, o motor nativo e a tela Sobre. Use para rodar, testar, tirar prints ou confirmar uma mudança no app desktop, no motor (engine/) ou no diálogo de plugins.
---

# Rodar e testar o Raven Audio Editor desktop

Testado no Windows 10, Node 24, Electron 45, JUCE 9.0.5, em 18/11/2026.
O app é controlado pelo protocolo de depuração do Chromium (CDP), com o
`WebSocket` nativo do Node. Não precisa de Playwright.

Arquivos desta skill:
- `driver/cdplib.mjs`: clicar, teclar, avaliar JS na página, tirar print.
- `driver/plugin-flow.mjs`: cenário completo pela interface, com 9 verificações.
- `driver/engine-smoke.mjs`: testa o motor sozinho (ping, lista, processamento).

## Pré-requisitos

1. `npm install` na raiz (o `postinstall` roda `quasar prepare`) e em `src-electron/`.
2. Submódulo do JUCE: `git submodule update --init`.
3. Motor compilado: `npm run build:engine` gera `engine/bin/raven-engine.exe`.
   Precisa do Visual Studio 2022 Build Tools (carga "Desenvolvimento para desktop
   com C++") e do CMake 3.22 ou mais novo (testado com o 4.4.4 do winget e com o
   3.31 que vem no Build Tools). **Dev-C++/MinGW não serve.**
4. Plugin **kHs Gain** instalado (Kilohearts Essentials, gratuito). Os cenários
   usam ele porque o resultado é calculável: Gain a 20% do slider dá −18 dB.

## Armadilhas (leia antes)

- **`ELECTRON_RUN_AS_NODE=1`**: o terminal do VS Code/Claude herda essa variável
  e o Electron vira Node puro (`does not provide an export named 'BrowserWindow'`).
  Rode `unset ELECTRON_RUN_AS_NODE` antes de abrir o app.
- **Git Bash converte argumentos com `/`** (`/m` vira `M:/`). Para o MSBuild use
  `cmake --build ... --parallel`, nunca `-- /m`.
- **Motor travado em uso**: com o app aberto, matar o `raven-engine` não adianta,
  porque o `engine-host.js` o reinicia na hora e o arquivo fica travado. A cópia
  para `engine/bin` falha. **Feche o app antes de recompilar o motor.**
- **Modo dev**: o DevTools abre encaixado (a página fica com ~725 px) e também
  aparece como alvo "page" no CDP. O `cdplib.mjs` já escolhe a página do app
  (URL http/file).
- **Mudar o `quasar.config.js` com o `quasar dev` aberto** reinicia o Electron, e
  o novo pode falhar com "address already in use" (porta 5858/9333). Encerre e
  suba de novo (ver "Encerrar").
- **Expressões dentro de `c.evaluate(...)`**: evite `\n`, `\s` e regex em template
  strings, porque a barra invertida se perde. Use `String.fromCharCode(10)`.
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
```

O `engine-smoke.mjs` exige RMS a −18 dB com erro < 0,001 (dá 0,0445 exato).
Avisos `lilv ... Reloading plugin` no stderr da varredura são inofensivos.

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
