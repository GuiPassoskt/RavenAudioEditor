# Análise do Audacity 3.7.9 e mapeamento para o Raven Audio Editor

Este documento registra como o Audacity funciona internamente (pelo código da tag
`release-3.7.9`) e como cada mecanismo foi reproduzido nesta aplicação Quasar.
Cada afirmação aponta o arquivo do Audacity que a sustenta.

## 1. Método

A ideia era usar o [REA (Reverse Engineer Anything)](https://github.com/morluto/rea),
versão `rea-agents@6.5.0`.

- O REA foi feito para alvos **sem código-fonte**: binários nativos (via Hopper,
  Ghidra ou IDA), apps Electron/JS, assemblies .NET, APKs e sites. O próprio skill
  do REA (`.agents/skills/reverse-engineer-anything/SKILL.md`) diz:
  *"For ordinary analysis of a complete source repository, use normal repository
  tools and do not run REA"*.
- O único comando do REA para árvores de código, `rea import-reference-source`, foi
  executado sobre o Audacity e falhou com
  `unsupported_host: Safe no-follow file opens are unavailable on this host` (ele
  só funciona em Linux, WSL ou macOS, e esta máquina não tem WSL).
- Com o código-fonte completo do Audacity disponível, seguimos o **método** do
  REA (cada conclusão com evidência e com as incógnitas registradas), mas usando
  leitura direta do repositório.

Os clones de referência ficam em `refs/` (ignorados pelo git):
`refs/audacity` (tag release-3.7.9) e `refs/rea`.

## 2. Arquitetura do Audacity 3.7.9

| Camada | Onde | Papel |
|---|---|---|
| Bibliotecas de domínio | `libraries/lib-*` (cerca de 80) | Núcleo sem dependência de GUI: faixas, amostras, undo, mixer, áudio I/O, efeitos |
| Aplicação wxWidgets | `src/` | Janelas, menus (`src/menus`), barras (`src/toolbars`), painéis de faixa, diálogos de efeito |
| Módulos | `modules/` | Extensões carregadas em tempo de execução (scripting, etc.) |
| Audacity 4 | `au4/` | Nova interface Qt/QML, em paralelo, fora do build 3.x |
| Terceiros | `lib-src/` | PortAudio, libsndfile, libsoxr, SoundTouch, SBSMS, etc. |

### 2.1 Mecanismos centrais e evidências

| Mecanismo | Como funciona no Audacity | Evidência |
|---|---|---|
| Modelo de faixas | `TrackList` com `WaveTrack`s. Cada faixa tem clips (`WaveClip`), e cada clip tem uma `Sequence` de `SampleBlock`s | `libraries/lib-track`, `libraries/lib-wave-track/WaveTrack.cpp`, `SampleBlock.h` |
| Edição | `WaveTrack::Cut/Copy/Clear/Paste/Silence/Split` trabalham em tempo (segundos) e convertem para amostras | `WaveTrack.cpp:955` (Cut), `:1097` (Copy), `:1161` (Clear), `:2002` (Paste), `:2016` (Silence), `:3346` (Split) |
| Volume e pan | Lei **linear**: `pan<0 → right = pan+1`, `pan>0 → left = 1-pan`, multiplicado pelo volume | `WaveTrack::GetChannelVolume` em `WaveTrack.cpp` |
| Undo/Redo | `UndoManager` guarda uma pilha de estados do projeto. `PushState` descarta o redo (`AbandonRedo`). `CONSOLIDATE` funde estados repetidos (usado por sliders). Os SampleBlocks são compartilhados entre estados, sem cópia | `libraries/lib-project-history/UndoManager.cpp:222` (PushState), `:255` (AbandonRedo), `:277/291` (Undo/Redo) |
| Desenho do waveform | Resumos (min, max, rms) a cada 256 e a cada 65536 amostras. Cada coluna de pixel usa o nível mais grosso que cabe nela | `lib-wave-track/SampleBlock.h:70` (GetSummary256), `lib-wave-track-paint/waveform/WaveDataCache.cpp` (MinMaxRMS256/64k, `rms = sqrt(sqSum/n)`) |
| Áudio I/O | `AudioIO` sobre PortAudio, com thread próprio, buffers circulares e pausa | `libraries/lib-audio-io/AudioIO.h` (`SetPaused`, `mCaptureRate`) |
| Comandos e menus | Cada item de menu registra um `Command(id, rótulo, função, flags, atalho)` | `src/menus/EditMenus.cpp:1154+`, `SelectMenus.cpp`, `TransportMenus.cpp` |
| Efeitos | Efeitos sem estado processam por bloco (`ProcessBlock`). Os com análise, como Normalize, fazem duas passadas | `libraries/lib-builtin-effects/*Base.cpp` |
| Projeto | Arquivo `.aup3` é um banco SQLite (tabelas de projeto e de sampleblocks) | `libraries/lib-project-file-io` |

### 2.2 Algoritmos de efeito portados

| Efeito | Lógica do Audacity | Arquivo |
|---|---|---|
| Amplificar | `out = in * ratio`. O valor inicial é `ratio = 1/pico` (pico vai a 0 dB). Bloqueia se causar clipping | `AmplifyBase.cpp:86,105` |
| Normalizar | Passada 1: `offset = -média` e `extent = max\|x+offset\|`. Passada 2: `(x+offset)·ratio/extent`. Estéreo pode ser independente ou conjunto | `NormalizeBase.cpp:135-179` |
| Fade In/Out | `in·i/n` e `in·(n-1-i)/n` | `Fade.cpp:61,68` |
| Inverter polaridade | `out = -in` | `Invert.cpp:68` |
| Reverse | Inverte a ordem das amostras | `Reverse.cpp` |
| Eco | Buffer circular `history` de `delay·rate` amostras: `out = in + history[pos]·decay`, depois `history[pos] = out` | `EchoBase.cpp:64-107` |
| Graves e Agudos | Dois filtros shelving em 250 Hz e 4000 Hz, slope 0.4 | `BassTrebleBase.cpp:218-220` |
| Tom | Senoide, quadrada, dente de serra e quadrada sem aliasing | `ToneGenBase.cpp:146-183` |
| Ruído | Branco, rosa (filtro de Paul Kellet) e marrom | `NoiseBase.cpp` |
| DTMF | Soma de duas senoides (linha e coluna do teclado) | `DtmfBase.cpp` |
| Mudar velocidade | Reamostragem (muda tempo e tom juntos) | `ChangeSpeedBase.cpp` |
| Repetir | Concatena a seleção N vezes | `RepeatBase.cpp` |
| Plotar espectro | Média de FFTs com janela (Hann por padrão) | `PlotSpectrumBase.cpp`, `src/FreqWindow.cpp` |
| Encontrar clipping | Sequências de amostras em ±1 | `FindClippingBase.cpp` |

### 2.3 Mesa de som, efeitos em tempo real e MIDI

| Mecanismo | Como funciona no Audacity | Evidência |
|---|---|---|
| Mesa de som | Uma coluna (`MixerTrackCluster`) por faixa, com nome, volume, pan, mudo, solo e medidor | `src/MixerBoard.cpp:135-319` |
| Efeitos em tempo real | Cada faixa tem uma `RealtimeEffectList`, e o projeto tem a lista **Master**. Permite adicionar, remover, reordenar e ligar/desligar | `lib-realtime-effects/RealtimeEffectList.h:69,75,110,122,150,166` |
| Ordem de processamento | O `RealtimeEffectManager` processa os grupos (faixas) e depois o `MasterGroup` | `RealtimeEffectManager.cpp:74,111-206` |
| Efeitos na exportação | O `Mixer` cria um `EffectStage` por entrada e aplica os `masterEffects` no fim | `lib-mixer/Mix.cpp:68-196,414-431` |
| Note Track (MIDI) | Embrulha uma sequência Allegro (`Alg_seq`). Só tem edições de intervalo (`Cut/Copy/Clear/Paste/Trim/Shift`) e `ExportMIDI` | `lib-note-track/NoteTrack.h:48,101-123` |
| Importar MIDI | Pelo módulo de importação, que usa portsmf/Allegro | `modules/track-ui/mod-midi-import-export/ImportMIDI.cpp` |
| Tocar MIDI | Envia as notas a um **dispositivo MIDI externo** via PortMidi. O Audacity não sintetiza som | `lib-note-track/MIDIPlay.h` |
| Exibir notas | Retângulos numa faixa de alturas (bottom/top note) | `src/tracks/playabletrack/notetrack/ui/NoteTrackDisplayData.cpp` |

## 3. Mapeamento para a aplicação

| Audacity | Raven Audio Editor |
|---|---|
| `TrackList` / `WaveTrack` | `src/stores/project.js`: `tracks[]` com `channels: Float32Array[]`, `offset`, `gain`, `pan`, `mute`, `solo` |
| `SampleBlock` imutável e compartilhado | Os `Float32Array` nunca são alterados no lugar (`src/audio/buffer.js`). O undo guarda só referências |
| `UndoManager` | `pushState / undo / redo / goToState`, com descarte do redo e consolidação para sliders |
| `HistoryWindow` | `src/components/HistoryPanel.vue` |
| `Clipboard` | Variável `clipboard` no store (copiar, recortar, colar entre faixas) |
| `WaveformView` + `WaveDataCache` | `src/components/WaveformCanvas.vue` + `src/audio/summary.js` (resumos de 256 e 65536 amostras) |
| `AdornedRulerPanel` (Quick-Play) | `src/components/TimeRuler.vue` (clique na régua reproduz a partir dali) |
| `AudioIO` / PortAudio | `src/audio/engine.js` (Web Audio API, AudioWorklet para gravação) |
| `CommandManager` + menus | `src/composables/commands.js` (um registro alimenta menus, botões e teclado) |
| `ControlToolBar`, `ToolsToolBar`, `EditToolBar`, `MeterToolBar` | `src/components/MainToolbar.vue`, `LevelMeter.vue` |
| `SelectionBar` / `TimeToolBar` | `src/components/SelectionBar.vue` |
| `EffectUI` / `ShuttleGui` | `src/components/EffectDialog.vue` (formulário gerado do esquema `params`, com Prévia de 6 s) |
| Efeitos embutidos | `src/audio/effects.js` + `src/audio/dsp.js` |
| `.aup3` (SQLite) | `.ravenproj` (cabeçalho JSON + amostras Float32), em `src/audio/fileio.js` |
| Exportar WAV (libsndfile) | `encodeWav` (PCM 16-bit ou float 32-bit) |
| `MixerBoard` / `MixerTrackCluster` | `src/components/MixerBoard.vue`, `MixerStrip.vue`. Inclui coluna Master, inserts de efeito e medidores pós-fader por faixa |
| `RealtimeEffectList` / `RealtimeEffectState` | `track.effects` e `master.effects` no store (imutáveis, entram no undo). Cada efeito vira nós Web Audio em `src/audio/realtime.js`, com bypass por crossfade |
| `RealtimeEffectPanel` | `src/components/RealtimeEffectsPanel.vue` (gaveta lateral) |
| `EffectStage` na exportação | `engine.render`: o mesmo grafo da reprodução, num `OfflineAudioContext` |
| `NoteTrack` + `Alg_seq` | Faixa `kind: 'midi'` com `notes[]` em segundos. Edição de intervalo em `src/audio/notes.js` |
| `ImportMIDI` / `ExportMIDI` | `src/audio/midifile.js` (SMF 0/1, mapa de andamento, running status) |
| `MIDIPlay` (PortMidi) | **Diferente:** sintetizador embutido (`src/audio/synth.js`), com timbres por família GM e bateria no canal 10 |
| `NoteTrackView` | Notas desenhadas na faixa (`WaveformCanvas.vue`) e **piano roll completo** (`PianoRoll.vue`), que o Audacity não tem |

## 4. Diferenças e limitações conhecidas

- **Clips:** cada faixa tem um único bloco contínuo de áudio, sem vários
  `WaveClip`s por faixa. A ferramenta "mover no tempo" desloca a faixa inteira.
- **Reamostragem:** é linear. O Audacity usa libsoxr, com qualidade superior.
  "Mudar velocidade" e "Taxa do projeto" sentem essa diferença.
- **Formatos:** a importação usa os decodificadores do navegador (WAV, MP3, OGG,
  FLAC, M4A, conforme o navegador). A exportação é só WAV.
- **Não implementados:** faixas de rótulo, envelope de volume, visão de
  espectrograma, redução de ruído, mudar tom/tempo sem alterar o outro (SBSMS ou
  SoundTouch), plugins (VST, LV2, Nyquist), macros e sincronização de faixas
  (sync-lock).
- **Efeitos em tempo real:** usam nós nativos da Web Audio API (`BiquadFilterNode`,
  `DynamicsCompressorNode`, `ConvolverNode`, etc.). O Eco é o mesmo laço de
  realimentação do `EchoBase`. O compressor, o limitador e o reverb (por
  convolução com resposta sintética) **não** são os algoritmos do Audacity. Mudar
  a estrutura da cadeia durante a reprodução reinicia o áudio do ponto atual;
  mudar parâmetros e ligar/desligar não reinicia.
- **MIDI:** o andamento é único (o primeiro do arquivo), e a grade assume 4/4.
  Controladores (pitch bend, sustain, CC) e mudanças de programa no meio da
  faixa são ignorados. O sintetizador é simples (osciladores com ADSR), sem
  soundfont. Não há gravação de um teclado MIDI externo (Web MIDI).
- **Gravação:** a latência de entrada não é compensada (o Audacity tem
  "Latency compensation" nas preferências). O overdub toca as outras faixas
  enquanto grava.
- **Memória:** todo o áudio fica em RAM como Float32. O Audacity faz paginação
  em disco via SQLite, então projetos de horas cabem nele e podem não caber aqui.
