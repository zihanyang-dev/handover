/**
 * How far along the way in somebody is, as a track they can see the end of.
 *
 * Measured from Notion's own setup bar: a 6px pill, the track a tint of the fill rather than a
 * grey. The mark rides the leading edge — progress is a thing that is moving, not a thing that
 * has a number.
 */

import type { CSSProperties } from 'react'
import { Mark, type MarkState } from '../../mark.tsx'

const LEGS = ['Space', 'Machine'] as const

export function Steps({
  step,
  done = false,
  mark = 'idle',
}: {
  readonly step: 1 | 2
  readonly done?: boolean
  readonly mark?: MarkState
}) {
  // The rider rests mid-leg of where things stand: a quarter in for the first, three for the
  // second, all the way once there is nothing left.
  const at = done ? 100 : step === 1 ? 25 : 75
  const leg = done ? 'Done' : `Step ${String(step)} of 2`

  return (
    <div className="steps" role="img" aria-label={leg}>
      <span className="steps-said">{leg}</span>
      <div className="steps-track" style={{ '--at': `${String(at)}%` } as CSSProperties}>
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
