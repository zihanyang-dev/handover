// Adapted from Kanna's AnimatedShinyText.
// Copyright (c) 2025 Jake Mor. Licensed under the MIT terms in THIRD_PARTY_NOTICES.md.

import type { ComponentPropsWithoutRef, CSSProperties } from 'react'
import { cn } from '../../lib/utils.ts'

export type AnimatedShinyTextProps = ComponentPropsWithoutRef<'span'> & {
  readonly shimmerWidth?: number
  readonly animate?: boolean
}

export function AnimatedShinyText({
  children,
  className,
  shimmerWidth = 100,
  animate = true,
  style,
  ...props
}: AnimatedShinyTextProps) {
  const halfShimmerWidth = Math.min(Math.max(shimmerWidth, 0), 100) / 2

  return (
    <span
      className={cn(
        'chat-shiny-text relative inline-block max-w-md overflow-hidden text-ellipsis whitespace-nowrap align-top',
        !animate && 'text-ink-muted',
        className,
      )}
      style={
        {
          ...style,
          '--shiny-half-width': `${String(halfShimmerWidth)}px`,
        } as CSSProperties
      }
      {...props}
    >
      {children}
      {animate ? (
        <span aria-hidden className="chat-shiny-track pointer-events-none absolute inset-0 block">
          <span className="chat-shiny-copy block h-full w-full overflow-hidden text-ellipsis whitespace-nowrap">
            {children}
          </span>
        </span>
      ) : null}
    </span>
  )
}
