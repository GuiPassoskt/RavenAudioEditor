// Configuração do Quasar CLI (Vite). https://v2.quasar.dev/quasar-cli-vite/quasar-config-file
export default () => ({
  boot: [],
  css: ['app.scss'],
  extras: ['roboto-font', 'material-icons', 'material-symbols-rounded', 'mdi-v7'],
  build: {
    target: { browser: ['es2022', 'firefox115', 'chrome115', 'safari15'], node: 'node20' },
    vueRouterMode: 'hash',
    // Disponível no app como process.env.BUILD_DATE (mostrado no splash).
    env: { BUILD_DATE: new Date().toISOString() }
  },
  devServer: { open: true },
  framework: {
    config: { dark: true },
    plugins: ['Notify', 'Dialog', 'Loading']
  }
})
