<template>
  <q-dialog v-model="ui.shortcutsOpen">
    <q-card dark style="width: 560px; max-width: 95vw">
      <q-card-section class="text-h6">Atalhos de teclado</q-card-section>
      <q-card-section class="q-pt-none shortcuts">
        <q-markup-table dense dark flat>
          <tbody>
            <tr v-for="[id, c] in withKeys" :key="id">
              <td>{{ c.label }}</td>
              <td class="text-right"><kbd v-for="k in [c.keys, ...(c.alt ?? [])]" :key="k" class="mono">{{ k }}</kbd></td>
            </tr>
            <tr><td>Zoom com a roda do mouse</td><td class="text-right"><kbd>Ctrl+Roda</kbd></td></tr>
            <tr><td>Rolagem horizontal</td><td class="text-right"><kbd>Shift+Roda</kbd></td></tr>
            <tr><td>Estender seleção</td><td class="text-right"><kbd>Shift+Clique</kbd></td></tr>
            <tr><td>Selecionar várias faixas</td><td class="text-right"><kbd>Ctrl+Clique</kbd></td></tr>
            <tr><td>Selecionar faixa inteira</td><td class="text-right"><kbd>Duplo clique</kbd></td></tr>
          </tbody>
        </q-markup-table>
      </q-card-section>
      <q-card-actions align="right"><q-btn v-close-popup flat label="Fechar" /></q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog v-model="ui.aboutOpen">
    <q-card dark style="width: 520px; max-width: 95vw">
      <q-card-section class="row items-center">
        <img src="assets/img/splash/icon-192.png" width="56" height="56" alt="" style="border-radius: 12px">
        <div class="q-ml-md">
          <div class="text-h6">Raven Audio Editor</div>
          <div class="text-caption text-grey-6">Versão 0.1.0 · Quasar {{ $q.version }}</div>
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        Editor de áudio multipista no navegador, criado a partir da análise do código-fonte do
        <b>Audacity 3.7.9</b>. O processamento é todo local (Web Audio API); nenhum áudio sai da sua máquina.
        <br><br>
        Não é afiliado ao projeto Audacity®. Veja <span class="mono">docs/ANALISE-AUDACITY.md</span>
        para o mapeamento entre os módulos do Audacity e esta aplicação.
      </q-card-section>
      <q-card-actions align="right"><q-btn v-close-popup flat label="Fechar" /></q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useUiStore } from 'src/stores/ui'
import { useCommands } from 'src/composables/commands'

const ui = useUiStore()
const { cmds } = useCommands()
const withKeys = computed(() => Object.entries(cmds).filter(([, c]) => c.keys))
</script>

<style scoped>
.shortcuts { max-height: 60vh; overflow-y: auto; }
kbd { background: #0b0812; border: 1px solid var(--ed-border); border-radius: 4px; padding: 1px 6px; margin-left: 4px; font-size: 11px; }
</style>
