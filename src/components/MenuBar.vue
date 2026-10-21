<template>
  <div class="menu-bar row items-center no-wrap">
    <div class="brand row items-center q-px-sm">
      <img src="assets/img/splash/icon-64.png" width="22" height="22" alt="" class="brand-icon">
      <span class="q-ml-sm">{{ store.name }}<span v-if="store.dirty" class="text-grey-6"> •</span></span>
    </div>
    <q-btn v-for="menu in menus" :key="menu.label" flat dense no-caps size="13px" :label="menu.label" class="q-px-sm">
      <q-menu dark auto-close :offset="[0, 2]">
        <q-list dense style="min-width: 260px">
          <template v-for="(id, i) in menu.items" :key="i">
            <q-separator v-if="id === '-'" dark />
            <q-item v-else clickable :disable="cmds[id].enabled ? !cmds[id].enabled() : false" @click="exec(id)">
              <q-item-section avatar style="min-width: 28px">
                <q-icon v-if="cmds[id].icon" :name="cmds[id].icon" size="18px" />
              </q-item-section>
              <q-item-section>{{ cmds[id].label }}</q-item-section>
              <q-item-section v-if="cmds[id].keys" side class="mono text-caption">{{ cmds[id].keys }}</q-item-section>
            </q-item>
          </template>
        </q-list>
      </q-menu>
    </q-btn>
  </div>
</template>

<script setup>
import { useProjectStore } from 'src/stores/project'
import { useCommands } from 'src/composables/commands'

const store = useProjectStore()
const { cmds, exec, menus } = useCommands()
</script>

<style scoped>
.menu-bar { background: var(--ed-panel); border-bottom: 1px solid var(--ed-border); height: 32px; }
.brand-icon { border-radius: 5px; }
.brand { font-size: 13px; font-weight: 500; min-width: 170px; max-width: 260px; overflow: hidden; white-space: nowrap; }
</style>
