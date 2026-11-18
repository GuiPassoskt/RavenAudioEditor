import { createRouter, createWebHashHistory } from 'vue-router'
import routes from './routes'

export default function () {
  return createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createWebHashHistory(import.meta.env.QUASAR_VUE_ROUTER_BASE)
  })
}
