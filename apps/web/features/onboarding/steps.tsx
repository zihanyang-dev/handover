/**
 * How far along the way in somebody is, as a track they can see the end of.
 *
 * Measured from Notion's own setup bar: a 6px pill, the track a tint of the fill rather than a
 * grey. The mark rides the leading edge — progress is a thing that is moving, not a thing that
 * has a number.
 */

import { useEffect, useState } from 'react'
import { Mark, type MarkState } from '../../mark.tsx'

const LEGS = ['Space', 'Machine'] as const

/** Long enough for one leg to move, short enough that Continue still feels immediate. */
export const STEP_EXIT_MS = 260

function progressAt(step: 1 | 2, done: boolean, entered: boolean): 25 | 50 | 75 | 100 {
  if (done) return step === 1 ? 50 : 100
  if (step === 1) return 25
  return entered ? 75 : 50
}

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

  const at = progressAt(step, done, entered)
  const leg = done && step === 2 ? 'Done' : `Step ${String(step)} of 2`

  return (
    // No outer spacing: where it sits is its parent's to say. It had a margin once and both of
    // its parents overrode it, one of them with a selector that never matched anything.
    //
    // Clipped, because the mark rides above and below a 6px track and the page has no room for it
    // there. The margin is what lets the mark keep its own shadow while the rest is cut.
    <div className="w-full overflow-clip [overflow-clip-margin:1rem]" role="img" aria-label={leg}>
      <span className="sr-only">{leg}</span>
      {/* Both the fill and the rider read their position from here, so one attribute moves both
          and neither can be a step behind the other. */}
      <div
        className="relative h-1.5 rounded-full bg-primary/10 data-[progress=25]:[--at:25%] data-[progress=25]:[--scale:0.25] data-[progress=50]:[--at:50%] data-[progress=50]:[--scale:0.5] data-[progress=75]:[--at:75%] data-[progress=75]:[--scale:0.75] data-[progress=100]:[--at:100%] data-[progress=100]:[--scale:1]"
        data-progress={at}
      >
        <div className="absolute inset-0 origin-left rounded-full bg-primary transition-transform duration-[320ms] ease-settle will-change-transform [transform:scaleX(var(--scale))]" />
        <div className="pointer-events-none absolute inset-0 transition-transform duration-[320ms] ease-settle will-change-transform [transform:translate3d(var(--at),0,0)]">
          <Mark
            className="absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2"
            size={26}
            state={mark}
          />
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 text-center text-copy-xxs text-basic">
        {LEGS.map((leg, i) => (
          <span key={leg} className={!done && i + 1 === step ? 'font-medium text-content' : ''}>
            {leg}
          </span>
        ))}
      </div>
    </div>
  )
}
