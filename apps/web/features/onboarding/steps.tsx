/**
 * How far along the way in somebody is, as a track they can see the end of.
 *
 * Measured from Notion's own setup bar: a 6px pill, the track a tint of the fill rather than a
 * grey. The mark rides the leading edge — progress is a thing that is moving, not a thing that
 * has a number.
 */

import { type CSSProperties, useEffect, useState } from 'react'
import { Mark, type MarkState } from '../../mark.tsx'

const LEGS = ['Space', 'Machine'] as const

/** Long enough for one leg to move, short enough that Continue still feels immediate. */
export const STEP_EXIT_MS = 260

export function Steps({
  step,
  done = false,
  mark = 'idle',
}: {
  readonly step: 1 | 2
  readonly done?: boolean
  readonly mark?: MarkState
}) {
  // A completed first step ends at the midpoint. The second mounts there, then advances on its
  // next paint: the rider only moves forward instead of sweeping to 100% and snapping back.
  const [entered, setEntered] = useState(step === 1)
  useEffect(() => {
    if (step === 1) return
    // Two frames guarantee the midpoint was painted before the compositor receives the next
    // transform. A timer can land in the same paint and make the rider appear to jump.
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        setEntered(true)
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [step])

  const at = done ? (step === 1 ? 50 : 100) : step === 1 ? 25 : entered ? 75 : 50
  const leg = done && step === 2 ? 'Done' : `Step ${String(step)} of 2`

  return (
    <div className="steps" role="img" aria-label={leg}>
      <span className="steps-said">{leg}</span>
      <div
        className="steps-track"
        style={
          {
            '--at': `${String(at)}%`,
            '--scale': String(at / 100),
          } as CSSProperties
        }
      >
        <div className="steps-fill" />
        <div className="steps-rider">
          <Mark size={26} state={mark} />
        </div>
      </div>
      <div className="steps-labels">
        {LEGS.map((leg, i) => (
          <span key={leg} data-here={!done && i + 1 === step ? '' : undefined}>
            {leg}
          </span>
        ))}
      </div>
    </div>
  )
}
