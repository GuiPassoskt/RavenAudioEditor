# Raven Audio Editor

Editor de áudio multipista no navegador, feito com [Quasar Framework](https://quasar.dev/)
(Vue 3 + Vite + Pinia) e inspirado no [Audacity 3.7.9](https://github.com/audacity/audacity/tree/release-3.7.9).
Todo o processamento é local, pela Web Audio API.

A análise do Audacity que originou o projeto está em
[docs/ANALISE-AUDACITY.md](docs/ANALISE-AUDACITY.md).

O plano para evoluir para um app **Electron + C++** com plugins de terceiros
(VST3, LV2, CLAP, AU) e, depois, uma DAW está em
[docs/INTEGRACAO-PLUGINS-NATIVOS.md](docs/INTEGRACAO-PLUGINS-NATIVOS.md),
com diagramas da arquitetura-alvo.

## Funcionalidades

- **Tela de abertura (splash):** arte em `public/assets/img/splash/splash.png` com
  informações técnicas: versão, data do build, Quasar/Vue e um diagnóstico real do
  ambiente (taxa e latência do dispositivo de áudio, AudioWorklet, Web MIDI,
  núcleos, memória, entradas/saídas e formatos suportados). Tem a opção "Não
  mostrar ao iniciar" e pode ser reaberta em Ajuda → Tela de abertura.
- **Identidade visual "Raven":** a paleta da interface vem da arte do splash
  (`src/css/app.scss` e `src/css/quasar.variables.scss`). As cores das faixas
  são independentes (`src/audio/colors.js`).

- **Faixas:** várias faixas mono ou estéreo, cada uma com ganho, pan, mudo, solo,
  renomear, reordenar e remover. Também há "Mixar e renderizar" e "Estéreo para mono".
- **Importar:** arquivos de áudio pelo menu ou arrastando para a janela.
- **Gravar (como no REAPER):** crie uma faixa (Faixas → Nova faixa mono ou
  estéreo), selecione-a e pressione R. A gravação começa no cursor, na(s) faixa(s)
  de áudio selecionada(s). Faixa mono grava a entrada 1; faixa estéreo, as
  entradas 1/2. O trecho gravado substitui o que havia ali, aparece ao vivo em
  vermelho e o projeto toca junto (overdub). Sem faixa de áudio selecionada, o
  app avisa em vez de criar uma faixa sozinho.
- **Reproduzir:** play, pausa, parar, ir para o início ou fim, loop da seleção e
  Quick-Play ao clicar na régua. Medidores de pico de reprodução e de gravação.
- **Editar:** recortar, copiar, colar, excluir, duplicar, silenciar, aparar e
  dividir em nova faixa.
- **Desfazer/refazer:** histórico ilimitado (até 200 estados) e painel de
  Histórico para voltar a qualquer ponto.
- **Seleção:** arrastar no waveform (pode abranger várias faixas), Shift+clique
  para estender, duplo clique seleciona a faixa inteira. Os campos de início, fim
  e duração são editáveis.
- **Zoom e navegação:** aproximar, afastar, ajustar à janela e zoom na seleção;
  Ctrl+roda dá zoom e Shift+roda rola. Com zoom alto o waveform mostra as
  amostras individuais.
- **Efeitos:** Amplificar, Normalizar, Fade In/Out, Reverse, Inverter
  polaridade, Eco, Graves e Agudos, Passa-baixa/alta, Compressor, Mudar
  velocidade e Repetir. Todos têm prévia de 6 s e lembram os últimos valores usados.
- **Gerar:** Tom (4 formas de onda), Ruído (branco, rosa, marrom), DTMF e Silêncio.
- **Analisar:** Plotar espectro (FFT com janela de Hann, eixo log ou linear,
  detecção do pico com nota musical), Encontrar clipping e Estatísticas (pico,
  RMS, DC).
- **Cores por faixa:** cada faixa nova recebe uma cor da paleta, usada no cabeçalho,
  no clip (com faixa de título), na onda ou nas notas, na mesa de som e no piano roll.
  Para trocar, clique no ícone da faixa ou use o menu ⋮ (a troca entra no desfazer).
- **Mesa de som** (Ctrl+M): uma coluna por faixa com fader, pan, mudo/solo,
  medidor pós-fader e os efeitos inseridos, mais a coluna Master com fader e efeitos.
- **Efeitos em tempo real por faixa e no master** (tecla E ou o botão na faixa):
  Ganho, Graves e Agudos, Filtro, Eco, Reverb, Compressor, Limitador e Distorção.
  Não alteram o áudio original. Podem ser ajustados durante a reprodução,
  desligados (bypass) e reordenados, entram no desfazer e são aplicados na
  exportação. "Aplicar na faixa" grava o resultado no áudio.
- **MIDI e piano roll** (F7): importa `.mid` (cada canal vira uma faixa) e
  toca com o sintetizador embutido (famílias GM e bateria no canal 10). No
  piano roll dá para criar, mover, redimensionar e apagar notas, selecionar por
  caixa, ajustar a velocity, transpor, quantizar e copiar/colar/duplicar.
  Recortar, copiar, colar, aparar e silenciar também funcionam na faixa MIDI.
  Exporta `.mid` e renderiza MIDI em áudio.
- **Arquivos:** salvar e abrir projeto `.ravenproj` (inclui MIDI, efeitos e
  master); exportar WAV (16-bit ou 32-bit float), do projeto inteiro ou só da seleção.

## Rodando

Requer Node 22 (testado com 22.21). O `@quasar/app-vite` está fixado em `2.5.3`,
porque as versões 2.5.4 e seguintes exigem Node ≥ 22.22.

```bash
npm install
npm run dev      # servidor de desenvolvimento (abre o navegador)
npm run build    # gera dist/spa
npm test         # testes dos algoritmos de áudio (node:test)
```

O build precisa ser servido por HTTP; abrir o `index.html` direto (`file://`) não funciona.
A gravação exige `localhost` ou HTTPS, por causa da permissão de microfone.

## Atalhos principais

| Ação | Tecla |
|---|---|
| Reproduzir / parar | Espaço |
| Pausar / gravar / loop | P / R / L |
| Desfazer / refazer | Ctrl+Z / Ctrl+Y |
| Recortar / copiar / colar / excluir | Ctrl+X / Ctrl+C / Ctrl+V / Delete |
| Duplicar / silenciar / aparar | Ctrl+D / Ctrl+L / Ctrl+T |
| Selecionar tudo / nada | Ctrl+A / Ctrl+Shift+A |
| Zoom + / normal / − / seleção / ajustar | Ctrl+1 / Ctrl+2 / Ctrl+3 / Ctrl+E / Ctrl+F |
| Importar / exportar / salvar | Ctrl+Shift+I / Ctrl+Shift+E / Ctrl+S |
| Mesa de som / efeitos da faixa / piano roll | Ctrl+M / E / F7 |

No piano roll: clique cria nota, arrastar move, a borda direita muda a
duração, botão direito apaga, Shift+arrastar seleciona, ↑/↓ transpõe
(Shift: oitava), ←/→ move pela grade, Q quantiza, Ctrl+D duplica e Delete exclui.

A lista completa está em **Ajuda → Atalhos de teclado** (F2).

## Estrutura

```
src/
  audio/         núcleo de áudio, sem Vue (testável no Node)
    buffer.js    operações imutáveis sobre Float32Array, mixdown, pan linear
    realtime.js  efeitos em tempo real (nós Web Audio) e montagem de cadeias
    midifile.js  leitura/escrita de Standard MIDI Files
    notes.js     edição de intervalos sobre listas de notas
    synth.js     sintetizador das faixas MIDI (famílias GM + bateria)
    effects.js   catálogo de efeitos, geradores e analisadores
    dsp.js       biquads (RBJ), shelving, FFT, espectro médio
    summary.js   resumos min/max/rms (256 e 65536) para o waveform
    engine.js    grafo de reprodução/render offline, agendador MIDI, gravação
    fileio.js    WAV, .ravenproj, download e seleção de arquivos
    time.js      formatação de tempo
  stores/        Pinia: project.js (modelo, undo, edição, transporte), ui.js
  composables/   commands.js: registro de comandos (menus, botões, teclado)
  components/    TracksArea, TrackRow, WaveformCanvas, TimeRuler, MainToolbar,
                 MenuBar, SelectionBar, LevelMeter, EffectDialog, AnalysisDialogs,
                 HistoryPanel, InfoDialogs, MixerBoard, MixerStrip,
                 RealtimeEffectsPanel, PianoRoll
tests/           testes unitários dos algoritmos
docs/            análise do Audacity
refs/            clones de referência (Audacity 3.7.9 e REA), ignorados pelo git
```

## Limitações

Ver a seção 4 de [docs/ANALISE-AUDACITY.md](docs/ANALISE-AUDACITY.md).
Em resumo: um bloco de áudio por faixa (sem vários clips), reamostragem linear,
exportação de áudio só em WAV, sem rótulos, envelopes, espectrograma, redução
de ruído ou plugins, e todo o áudio fica em memória. No MIDI: andamento único,
controladores (pitch bend, sustain) ignorados e sintetizador simples, sem soundfont.
