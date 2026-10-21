<template>
  <canvas ref="canvas" class="ruler" title="Clique para reproduzir a partir deste ponto" @pointerdown="onDown" />
</template>

<script setup>
// Régua de tempo (equivalente ao AdornedRulerPanel do Audacity).
// Clicar inicia a reprodução a partir do ponto ("Quick-Play").

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from 'src/stores/project'
import { formatRuler } from 'src/audio/time'

const HEIGHT = 28
const STEPS = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 15, 30, 60, 300, 600, 1800, 3600]

const store = useProjectStore()
const canvas = ref(null)
let frame = 0
let observer = null

const schedule = () => { if (!frame) frame = requestAnimationFrame(draw) }

function draw () {
  frame = 0
  const cv = canvas.value
  if (!cv) return
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  store.viewWidth = w
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(HEIGHT * dpr)
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = '#1a1328'
  g.fillRect(0, 0, w, HEIGHT)

  const { pps, scrollTime, sel } = store
  const xOf = t => (t - scrollTime) * pps

  if (sel.t1 > sel.t0) {
    g.fillStyle = 'rgba(139,92,246,0.35)'
    g.fillRect(xOf(sel.t0), HEIGHT - 8, (sel.t1 - sel.t0) * pps, 8)
  }

  const major = STEPS.find(s => s * pps >= 90) ?? 3600
  const minor = major / (String(major).includes('5') ? 5 : 10)
  const t0 = Math.floor(scrollTime / minor) * minor
  const t1 = scrollTime + w / pps
  g.font = '11px Roboto, sans-serif'
  g.textBaseline = 'top'
  for (let i = 0; i < 5000; i++) {
    const t = t0 + i * minor // sem acumular erro de ponto flutuante
    if (t > t1) break
    const x = Math.round(xOf(t)) + 0.5
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
    g.strokeStyle = isMajor ? '#9a8db5' : '#574872'
    g.beginPath()
    g.moveTo(x, isMajor ? HEIGHT - 14 : HEIGHT - 6)
    g.lineTo(x, HEIGHT)
    g.stroke()
    if (isMajor) {
      g.fillStyle = '#d4c8ec'
      g.fillText(formatRuler(Math.max(0, t), major), x + 3, 3)
    }
  }
  g.fillStyle = '#32264a'
  g.fillRect(0, HEIGHT - 1, w, 1)
}

function onDown (e) {
  const rect = canvas.value.getBoundingClientRect()
  const t = Math.max(0, store.scrollTime + (e.clientX - rect.left) / store.pps)
  if (store.tracks.length) store.quickPlay(t)
}

watch(() => [store.pps, store.scrollTime, store.sel.t0, store.sel.t1], schedule)

onMounted(() => {
  observer = new ResizeObserver(schedule)
  observer.observe(canvas.value)
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame) })
</script>

<style scoped>
.ruler { display: block; width: 100%; height: 28px; cursor: pointer; }
</style>
