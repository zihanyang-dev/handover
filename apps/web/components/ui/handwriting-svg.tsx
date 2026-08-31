import { motion } from 'framer-motion'
import { cn } from '../../lib/class-names.ts'

type HandwritingSvgProps = {
  readonly path: string
  readonly className?: string
  readonly strokeClassName?: string
  readonly duration?: number
  readonly delay?: number
  readonly strokeWidth?: number
  readonly width?: number
  readonly height?: number
  readonly ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
}

/** Draw a supplied path once. Text-to-path generation belongs at build time, not in the browser. */
export function HandwritingSvg({
  path,
  className,
  strokeClassName,
  duration = 2,
  delay = 0.5,
  strokeWidth = 2,
  width = 100,
  height = 100,
  ease = 'easeInOut',
}: HandwritingSvgProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn('text-rose-500', className)}
      aria-hidden
    >
      <title>Handwriting SVG</title>
      <motion.path
        d={path}
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
