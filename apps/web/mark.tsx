/**
 * The Handover mark.
 *
 * Shipped to us as an AnimatedLogo component and reworked, not copied:
 *
 * - the viewBox is trimmed to the character's real bounding box (245 168 633 639). The one it
 *   came with carried an empty stage and a detached pom, so a `size` prop never meant the size
 *   you got;
 * - `role="img"` announces "Handover". The label it shipped with described the implementation
 *   ("Animated character logo, idle state") to whoever was listening.
 *
 * The motion lives in mark.css, one state per class; this file only says which one is on.
 */

import type { CSSProperties } from 'react'

/** What it is doing right now. */
export type MarkState = 'idle' | 'thinking' | 'working' | 'success'

const BODY = '#2b292a'

export function Mark({
  state = 'idle',
  size = 64,
  bodyColor = BODY,
  className,
}: {
  readonly state?: MarkState
  readonly size?: number
  readonly bodyColor?: string
  readonly className?: string | undefined
}) {
  return (
    <svg
      className={['mark', `mark-${state}`, className].filter(Boolean).join(' ')}
      style={
        {
          '--body': bodyColor,
          width: size,
          height: 'auto',
          maxWidth: '100%',
        } as CSSProperties
      }
      viewBox="245 168 633 639"
      role="img"
      aria-label="Handover"
    >
      <g className="mark-character">
        <path
          fill="var(--body)"
          d="M525 194q23-25 46 5c18 33 36 63 54 93 2 4 5 4 9 1l48-39c14-12 25-7 24 8l-6 68c24-5 48-10 66-11 23-1 43 9 54 25 14 21-6 66-27 84-11 10-25 17-39 22l81 17c26 5 35 16 22 33-16 21-48 40-78 57l-24 14c-3 2-3 6-1 10 20 33 37 68 43 103 2 9-3 12-11 12-35 3-69 3-103-4-1 29-4 58-12 83-5 17-17 21-31 14-35-19-67-51-93-86-21 29-43 55-67 75-10 9-18 3-21-9-8-26-8-52-6-78l-57 32c-18 10-29 1-24-16l20-75c-14 10-29 19-43 21-20 3-39-7-46-24-6-13-1-27 9-41l30-42c-28 0-50-6-65-17-22-17-20-50-5-71 15-19 42-29 70-35 15-4 32-5 47-3-23-16-38-34-39-55-2-27 10-55 31-67 28-17 61-6 85 15l15 18c12-44 26-91 44-137z"
        />
        <g className="mark-face">
          <path
            fill="#fff"
            d="M500 446c30-4 48 20 51 54 3 32-12 55-41 58-31 3-51-16-52-51-1-33 13-57 42-61zm115 0c29-3 48 20 51 54 3 32-13 55-43 59-31 3-52-18-51-52 1-32 15-58 43-61z"
          />
          <g className="mark-pupils" fill="var(--body)">
            <ellipse cx="519" cy="510" rx="16" ry="17" />
            <ellipse cx="634" cy="510" rx="16" ry="17" />
          </g>
        </g>
      </g>
    </svg>
  )
}
