/**
 * The wordmark drawing itself, on the sign-in screen. Not ours: it arrived from 21st.dev.
 *
 * Kept as it came, for the same reason as its neighbour: it follows the conventions of where it
 * came from, and this is the one place in the repository where that is true on purpose.
 */

'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { Font } from 'opentype.js'
import { cn } from '../../lib/utils.ts'

const DEFAULT_FONT_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/indieflower/IndieFlower-Regular.ttf'

/** Strict mode may mount twice; one word should still mean one font read. */
const FONTS = new Map<string, Promise<Font>>()

async function fontAt(url: string): Promise<Font> {
  const present = FONTS.get(url)
  if (present !== undefined) return present

  const loading = fetch(url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Font returned ${String(response.status)}`)
      return response.arrayBuffer()
    })
    .then(async (buffer) => {
      const opentype = await import('opentype.js')
      return opentype.parse(buffer)
    })
  FONTS.set(url, loading)
  void loading.catch(() => {
    FONTS.delete(url)
  })
  return loading
}

interface HandwritingSvgProps {
  readonly path?: string
  readonly text?: string
  readonly fontUrl?: string
  readonly className?: string
  readonly strokeClassName?: string
  readonly duration?: number
  readonly delay?: number
  readonly strokeWidth?: number
  readonly width?: number
  readonly height?: number
  readonly fontSize?: number
  readonly ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
}

type DrawingProps = Required<
  Pick<HandwritingSvgProps, 'delay' | 'duration' | 'ease' | 'height' | 'strokeWidth' | 'width'>
> & {
  readonly className: string | undefined
  readonly strokeClassName: string | undefined
  readonly d: string
  readonly viewBox: string
}

function Drawing({
  d,
  viewBox,
  width,
  height,
  className,
  strokeClassName,
  strokeWidth,
  delay,
  duration,
  ease,
}: DrawingProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      className={cn('text-rose-500', className)}
      aria-hidden
    >
      <title>Handwriting SVG</title>
      <motion.path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={strokeClassName}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ delay, duration, ease }}
      />
    </svg>
  )
}

function Message({
  children,
  width,
  height,
  className,
  fontSize,
}: {
  readonly children: string
  readonly width: number
  readonly height: number
  readonly className: string | undefined
  readonly fontSize: number
}) {
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn('text-muted-foreground', className)}
      aria-hidden
    >
      <title>Handwriting SVG</title>
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fontSize={fontSize}>
        {children}
      </text>
    </svg>
  )
}

interface Generated {
  readonly forRequest: string
  readonly d: string | null
  readonly viewBox: string
}

function GeneratedDrawing({
  text,
  fontUrl,
  fontSize,
  ...drawing
}: DrawingProps & {
  readonly text: string
  readonly fontUrl: string
  readonly fontSize: number
}) {
  const request = `${fontUrl}\0${text}\0${String(fontSize)}`
  const [generated, setGenerated] = useState<Generated>()

  useEffect(() => {
    let cancelled = false
    void fontAt(fontUrl)
      .then((font) => {
        if (cancelled) return
        const path = font.getPath(text, 0, fontSize, fontSize)
        const box = path.getBoundingBox()
        const pad = 5
        const x = Math.floor(box.x1) - pad
        const y = Math.floor(box.y1) - pad
        const width = Math.ceil(box.x2 - box.x1) + pad * 2
        const height = Math.ceil(box.y2 - box.y1) + pad * 2
        setGenerated({
          forRequest: request,
          d: path.toPathData(2),
          viewBox: `${String(x)} ${String(y)} ${String(width)} ${String(height)}`,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setGenerated({ forRequest: request, d: null, viewBox: drawing.viewBox })
        }
      })
    return () => {
      cancelled = true
    }
  }, [drawing.viewBox, fontSize, fontUrl, request, text])

  if (generated?.forRequest !== request) {
    return (
      <Message
        width={drawing.width}
        height={drawing.height}
        className={drawing.className}
        fontSize={14}
      >
        Loading…
      </Message>
    )
  }
  if (generated.d === null) {
    return (
      <Message
        width={drawing.width}
        height={drawing.height}
        className={drawing.className}
        fontSize={12}
      >
        Invalid font
      </Message>
    )
  }
  return <Drawing {...drawing} d={generated.d} viewBox={generated.viewBox} />
}

const DEFAULTS = {
  fontUrl: DEFAULT_FONT_URL,
  duration: 2,
  delay: 0.5,
  strokeWidth: 2,
  width: 100,
  height: 100,
  fontSize: 48,
  ease: 'easeInOut',
} as const

export function HandwritingSvg(props: HandwritingSvgProps) {
  const {
    path,
    text,
    fontUrl,
    className,
    strokeClassName,
    duration,
    delay,
    strokeWidth,
    width,
    height,
    fontSize,
    ease,
  } = { ...DEFAULTS, ...props }
  const drawing: DrawingProps = {
    d: path ?? '',
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    width,
    height,
    className,
    strokeClassName,
    strokeWidth,
    delay,
    duration,
    ease,
  }

  if (path !== undefined && path !== '') return <Drawing {...drawing} />
  if (text !== undefined) {
    return <GeneratedDrawing text={text} fontUrl={fontUrl} fontSize={fontSize} {...drawing} />
  }
  return (
    <Message width={width} height={height} className={className} fontSize={12}>
      Provide path or text
    </Message>
  )
}
