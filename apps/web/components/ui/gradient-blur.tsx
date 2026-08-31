import { useEffect, useRef, type ReactNode } from 'react'

type Rgb = readonly [number, number, number]

type GradientBlurProps = { readonly children: ReactNode }

type Circle = {
  readonly color: Rgb
  readonly x: number
  readonly y: number
  alpha: number
}

type Trail = {
  x: number
  y: number
  sequence: number
  ready: boolean
}

type EmitOptions = {
  readonly circles: Circle[]
  readonly trail: Trail
  readonly x: number
  readonly y: number
}

const NOTION_COLORS: readonly Rgb[] = [
  [255, 139, 124], // red-300
  [255, 215, 134], // yellow-300
  [147, 205, 254], // blue-300
  [171, 229, 184], // green-300
  [214, 182, 246], // purple-300
]
const TRAIL_SPACING = 10
const MAX_CIRCLES = 220
const TRAIL_RADIUS = 64
const OPACITY_DECAY = 0.025
const BACKGROUND = '#ffffff'

function mix(first: Rgb, second: Rgb, amount: number): Rgb {
  return [
    Math.round(first[0] + (second[0] - first[0]) * amount),
    Math.round(first[1] + (second[1] - first[1]) * amount),
    Math.round(first[2] + (second[2] - first[2]) * amount),
  ]
}

function notionColor(sequence: number) {
  const phase = sequence / 12
  const index = Math.floor(phase) % NOTION_COLORS.length
  const nextIndex = (index + 1) % NOTION_COLORS.length
  return mix(NOTION_COLORS[index] as Rgb, NOTION_COLORS[nextIndex] as Rgb, phase % 1)
}

function addCircle(options: EmitOptions, x: number, y: number) {
  options.circles.push({ color: notionColor(options.trail.sequence), x, y, alpha: 1 })
  options.trail.sequence += 1
  if (options.circles.length > MAX_CIRCLES) options.circles.shift()
}

function emitTrail(options: EmitOptions) {
  const { trail, x, y } = options
  if (!trail.ready) {
    trail.x = x
    trail.y = y
    trail.ready = true
    addCircle(options, x, y)
    return
  }

  const distance = Math.hypot(x - trail.x, y - trail.y)
  if (distance < 1) return
  const steps = Math.max(1, Math.ceil(distance / TRAIL_SPACING))
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    addCircle(options, trail.x + (x - trail.x) * progress, trail.y + (y - trail.y) * progress)
  }
  trail.x = x
  trail.y = y
}

function drawCircle(context: CanvasRenderingContext2D, circle: Circle, radius: number) {
  const [red, green, blue] = circle.color
  const gradient = context.createRadialGradient(circle.x, circle.y, 0, circle.x, circle.y, radius)
  gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 0.3)`)
  gradient.addColorStop(0.28, `rgba(${red}, ${green}, ${blue}, 0.2)`)
  gradient.addColorStop(0.62, `rgba(${red}, ${green}, ${blue}, 0.07)`)
  gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`)

  context.globalAlpha = circle.alpha
  context.fillStyle = gradient
  context.beginPath()
  context.arc(circle.x, circle.y, radius, 0, Math.PI * 2)
  context.fill()
}

function clearCanvas(
  context: CanvasRenderingContext2D,
  size: { readonly width: number; readonly height: number },
  backgroundColor: string,
) {
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  if (backgroundColor === 'transparent') {
    context.clearRect(0, 0, size.width, size.height)
    return
  }
  context.fillStyle = backgroundColor
  context.fillRect(0, 0, size.width, size.height)
}

function drawTrail(
  context: CanvasRenderingContext2D,
  circles: Circle[],
  radius: number,
  fade: number,
) {
  for (const circle of circles) {
    drawCircle(context, circle, radius)
    circle.alpha -= fade
  }
  context.globalAlpha = 1
  let expired = 0
  while (expired < circles.length && (circles[expired] as Circle).alpha <= 0) expired += 1
  if (expired > 0) circles.splice(0, expired)
}

export function GradientBlur({ children }: GradientBlurProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (root === null || canvas === null || context === null || context === undefined) return

    const circles: Circle[] = []
    const trail: Trail = { x: 0, y: 0, sequence: 0, ready: false }
    const size = { width: 0, height: 0 }
    const resizeCanvas = () => {
      const bounds = root.getBoundingClientRect()
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 2)
      size.width = bounds.width
      size.height = bounds.height
      canvas.width = Math.round(size.width * ratio)
      canvas.height = Math.round(size.height * ratio)
      canvas.style.width = `${size.width}px`
      canvas.style.height = `${size.height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const animation = { frame: 0, previousAt: performance.now() }

    const draw = (now: number) => {
      animation.frame = 0
      const elapsedFrames = Math.min((now - animation.previousAt) / (1000 / 60), 3)
      animation.previousAt = now
      clearCanvas(context, size, BACKGROUND)
      drawTrail(context, circles, TRAIL_RADIUS, OPACITY_DECAY * elapsedFrames)
      if (circles.length === 0) {
        clearCanvas(context, size, BACKGROUND)
        return
      }
      animation.frame = requestAnimationFrame(draw)
    }

    const startDrawing = () => {
      if (animation.frame !== 0) return
      animation.previousAt = performance.now()
      animation.frame = requestAnimationFrame(draw)
    }

    const emitAt = (clientX: number, clientY: number) => {
      const bounds = root.getBoundingClientRect()
      emitTrail({
        circles,
        trail,
        x: clientX - bounds.left,
        y: clientY - bounds.top,
      })
      startDrawing()
    }
    const noteMouseMove = (event: globalThis.MouseEvent) => {
      emitAt(event.clientX, event.clientY)
    }
    const noteTouchMove = (event: globalThis.TouchEvent) => {
      const touch = event.touches.item(0)
      if (touch !== null) emitAt(touch.clientX, touch.clientY)
    }
    const endTrail = () => {
      trail.ready = false
    }

    resizeCanvas()
    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(root)
    const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reducedMotion) {
      globalThis.addEventListener('mousemove', noteMouseMove)
      globalThis.addEventListener('mouseleave', endTrail)
      globalThis.addEventListener('touchmove', noteTouchMove, { passive: true })
      globalThis.addEventListener('touchend', endTrail)
    }

    return () => {
      observer.disconnect()
      cancelAnimationFrame(animation.frame)
      globalThis.removeEventListener('mousemove', noteMouseMove)
      globalThis.removeEventListener('mouseleave', endTrail)
      globalThis.removeEventListener('touchmove', noteTouchMove)
      globalThis.removeEventListener('touchend', endTrail)
    }
  }, [])

  return (
    <div ref={rootRef} className="gradient-blur-field">
      <canvas ref={canvasRef} className="gradient-blur-canvas" aria-hidden />
      <div className="gradient-blur-ink">{children}</div>
    </div>
  )
}
