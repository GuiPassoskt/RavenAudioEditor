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
    <q-card dark class="about-card column no-wrap">
      <q-card-section class="row items-center">
        <img src="assets/img/splash/icon-192.png" width="56" height="56" alt="" style="border-radius: 12px">
        <div class="q-ml-md">
          <div class="text-h6">Raven Audio Editor</div>
          <div class="text-caption text-grey-6">
            Versão {{ version }}<span v-if="commit"> · {{ commit.slice(0, 7) }}</span> · Quasar {{ $q.version }}
          </div>
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        Editor de áudio multipista, criado a partir da análise do código-fonte do
        <b>Audacity 3.7.9</b>. Todo o processamento é local: nenhum áudio sai da sua máquina.
        <br><br>
        Não é afiliado ao projeto Audacity®. Veja <span class="mono">docs/ANALISE-AUDACITY.md</span>
        para o mapeamento entre os módulos do Audacity e esta aplicação.
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-subtitle2">Licença e código-fonte</div>
        <div class="text-caption text-grey-5 q-mt-xs">
          Software livre sob a <b>GNU Affero General Public License v3</b> (ou posterior). Você pode usar,
          estudar, modificar e redistribuir este programa nos termos dessa licença. Ele é distribuído
          <b>sem nenhuma garantia</b>.
        </div>
        <div class="row q-gutter-sm q-mt-sm">
          <q-btn
            outline dense no-caps color="primary" icon="code" type="a" target="_blank"
            :href="sourceUrl" label="Código-fonte desta versão"
          />
          <q-btn
            flat dense no-caps color="grey-4" icon="gavel" type="a" target="_blank"
            href="https://www.gnu.org/licenses/agpl-3.0.html" label="Texto da AGPLv3"
          />
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none col third-party">
        <div class="text-subtitle2">Componentes de terceiros</div>
        <div v-if="!thirdParty.length" class="text-caption text-grey-6">Carregando…</div>
        <q-list v-else dense dark>
          <template v-for="group in groups" :key="group.origin">
            <q-item-label header class="q-px-none">{{ group.origin }}</q-item-label>
            <q-expansion-item
              v-for="c in group.items" :key="c.name" dense dark expand-icon-class="text-grey-6"
              :label="c.name" :caption="[c.version, c.license].filter(Boolean).join(' · ')"
            >
              <a v-if="c.url" :href="c.url" target="_blank" class="text-caption text-primary">{{ c.url }}</a>
              <pre class="license-text">{{ c.text }}</pre>
            </q-expansion-item>
          </template>
        </q-list>
      </q-card-section>

      <q-card-actions align="right"><q-btn v-close-popup flat label="Fechar" /></q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useUiStore } from 'src/stores/ui'
import { useCommands } from 'src/composables/commands'
import pkg from '../../package.json'

// A AGPLv3 exige oferecer o código-fonte da versão em uso: o link aponta para o
// commit exato do build (import.meta.env.GIT_COMMIT, definido no quasar.config.js).
const REPOSITORY = 'https://github.com/GuiPassoskt/RavenAudioEditor'

const ui = useUiStore()
const { cmds } = useCommands()
const withKeys = computed(() => Object.entries(cmds).filter(([, c]) => c.keys))

const version = pkg.version
const commit = import.meta.env.GIT_COMMIT || ''
const sourceUrl = commit ? `${REPOSITORY}/tree/${commit}` : REPOSITORY

// Inventário gerado por "npm run licenses"; carregado só quando o Sobre abre.
const thirdParty = ref([])
const groups = computed(() => ['Interface', 'Desktop', 'Motor (JUCE)']
  .map(origin => ({ origin, items: thirdParty.value.filter(c => c.origin === origin) }))
  .filter(g => g.items.length))

watch(() => ui.aboutOpen, async open => {
  if (open && !thirdParty.value.length) {
    thirdParty.value = (await import('src/legal/third-party-licenses.json')).default
  }
})
</script>

<style scoped>
.shortcuts { max-height: 60vh; overflow-y: auto; }
.about-card { width: 600px; max-width: 95vw; max-height: 90vh; }
.third-party { overflow-y: auto; min-height: 120px; }
.license-text { white-space: pre-wrap; font-size: 11px; color: #b9b2c8; max-height: 240px; overflow-y: auto; background: #0b0812; padding: 8px; border-radius: 4px; }
kbd { background: #0b0812; border: 1px solid var(--ed-border); border-radius: 4px; padding: 1px 6px; margin-left: 4px; font-size: 11px; }
</style>
