// Adapted from Kanna's AnimatedShinyText.
// The original copyright and source terms are retained in styles/chat.css.

import type { ComponentPropsWithoutRef, CSSProperties } from 'react'
import { cn } from '../../lib/class-names.ts'

type AnimatedShinyTextProps = ComponentPropsWithoutRef<'span'> & {
  readonly shimmerWidthPx?: number
}

export function AnimatedShinyText({
  children,
  className,
  shimmerWidthPx = 100,
  style,
  ...props
}: AnimatedShinyTextProps) {
  const halfShimmerWidthPx = Math.min(Math.max(shimmerWidthPx, 0), 100) / 2

  return (
    <span
      className={cn(
        'chat-shiny-text relative inline-block max-w-md overflow-hidden text-ellipsis whitespace-nowrap align-top',
        className,
      )}
      style={
        {
          ...style,
          '--shiny-half-width': `${String(halfShimmerWidthPx)}px`,
        } as CSSProperties
      }
      {...props}
    >
      {children}
      <span aria-hidden className="chat-shiny-track pointer-events-none absolute inset-0 block">
        <span className="chat-shiny-copy block h-full w-full overflow-hidden text-ellipsis whitespace-nowrap">
          {children}
        </span>
      </span>
    </span>
  )
}
