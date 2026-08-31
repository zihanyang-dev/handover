/**
 * A short-lived celebration that survives route changes.
 *
 * The canvas belongs to document.body rather than React's current route, so creating a Space can
 * continue immediately while the particles finish. This is a clean-room particle simulation; it
 * does not depend on or reproduce a paid component's source.
 */

const COLORS = ['#0075de', '#f45b4f', '#f2b705', '#3fa76a', '#9867d9'] as const
const CANVAS_ID = 'handover-confetti-burst'

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  gravity: number
  drag: number
  rotation: number
  spin: number
  flip: number
  flipSpeed: number
  width: number
  height: number
  color: string
  delay: number
  life: number
}

function between(minimum: number, maximum: number) {
  return minimum + Math.random() * (maximum - minimum)
}

function makeParticle(index: number, total: number): Particle {
  const burstsFromCentre = index < total * 0.55
  const angle = between(Math.PI * 0.08, Math.PI * 0.92)
  const speed = between(260, 540)
  return {
    x: burstsFromCentre
      ? globalThis.innerWidth / 2 + between(-28, 28)
      : between(globalThis.innerWidth * 0.04, globalThis.innerWidth * 0.96),
    y: burstsFromCentre ? between(-8, 18) : between(-70, 16),
    vx: burstsFromCentre ? Math.cos(angle) * speed : between(-130, 130),
    vy: burstsFromCentre ? Math.sin(angle) * speed : between(70, 210),
    gravity: between(300, 520),
    drag: between(0.982, 0.992),
    rotation: between(-Math.PI, Math.PI),
    spin: between(-14, 14),
    flip: between(0, Math.PI * 2),
    flipSpeed: between(7, 15),
    width: between(6, 12),
    height: between(3, 6),
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0],
    delay: burstsFromCentre ? between(0, 0.12) : between(0.05, 0.45),
    life: between(2.2, 2.8),
  }
}

function canvasContext(canvas: HTMLCanvasElement) {
  try {
    return canvas.getContext('2d')
  } catch {
    return null
  }
}

function fitCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const scale = Math.min(globalThis.devicePixelRatio || 1, 2)
  canvas.width = Math.round(globalThis.innerWidth * scale)
  canvas.height = Math.round(globalThis.innerHeight * scale)
  canvas.style.width = `${globalThis.innerWidth}px`
  canvas.style.height = `${globalThis.innerHeight}px`
  context.setTransform(scale, 0, 0, scale, 0, 0)
}

function advance(particle: Particle, elapsed: number, delta: number) {
  const age = elapsed - particle.delay
  if (age < 0) return true
  if (age > particle.life) return false

  particle.vx *= particle.drag ** (delta * 60)
  particle.vy += particle.gravity * delta
  particle.x += particle.vx * delta
  particle.y += particle.vy * delta
  particle.rotation += particle.spin * delta
  particle.flip += particle.flipSpeed * delta
  return particle.y < globalThis.innerHeight + 24
}

function paint(context: CanvasRenderingContext2D, particle: Particle, elapsed: number) {
  const age = elapsed - particle.delay
  if (age < 0) return

  const fade = Math.min(1, Math.max(0, (particle.life - age) / 0.4))
  context.save()
  context.globalAlpha = fade
  context.translate(particle.x, particle.y)
  context.rotate(particle.rotation)
  context.scale(1, Math.cos(particle.flip))
  context.fillStyle = particle.color
  context.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height)
  context.restore()
}

function animationAllowed() {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return false
  return !globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function mountCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  document.querySelector(`#${CANVAS_ID}`)?.remove()
  canvas.id = CANVAS_ID
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '100',
    pointerEvents: 'none',
  })
  document.body.append(canvas)
  fitCanvas(canvas, context)
}

/** Celebrate across the whole page, then remove every trace when the particles are gone. */
export function burstConfetti() {
  if (!animationAllowed()) return

  const canvas = document.createElement('canvas')
  const context = canvasContext(canvas)
  if (context === null) return

  mountCanvas(canvas, context)
  const total = globalThis.innerWidth < 640 ? 104 : 156
  const particles = Array.from({ length: total }, (_, index) => makeParticle(index, total))
  let frame = 0
  let startedAt: number | undefined
  let previousAt: number | undefined
  let finished = false

  const resize = () => {
    fitCanvas(canvas, context)
  }
  const finish = () => {
    if (finished) return
    finished = true
    cancelAnimationFrame(frame)
    globalThis.removeEventListener('resize', resize)
    canvas.remove()
  }
  const animate = (now: number) => {
    startedAt ??= now
    previousAt ??= now
    const elapsed = (now - startedAt) / 1000
    const delta = Math.min((now - previousAt) / 1000, 0.034)
    previousAt = now

    context.clearRect(0, 0, globalThis.innerWidth, globalThis.innerHeight)
    let alive = 0
    for (const particle of particles) {
      if (!advance(particle, elapsed, delta)) continue
      paint(context, particle, elapsed)
      alive += 1
    }

    if (alive === 0 || elapsed > 3) {
      finish()
      return
    }
    frame = requestAnimationFrame(animate)
  }

  globalThis.addEventListener('resize', resize)
  frame = requestAnimationFrame(animate)
}
