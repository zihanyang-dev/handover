/**
 * What the agent means to do, as it stands.
 *
 * Pinned rather than left in the transcript, for the reason every write-up of this pattern gives:
 * a plan that arrives as a message scrolls away under the work that follows it, and the one
 * question somebody has when they look in — is it on the right track — is the one the page can no
 * longer answer without scrolling back.
 *
 * Collapsed to a line by default. The first anti-pattern in the same write-ups is expanding the
 * whole trace and burying the answer under process detail, so what stays visible is the two things
 * that are read at a glance — how far along, and what it is doing now — and the rest opens.
 *
 * Every version is still in the transcript, in order, which is what says it changed its mind. This
 * shows the last one; it is not where a plan is kept.
 */

import { useState } from 'react'
import { CaretDownFill, CaretRightFill, CheckCircleFill, Circle } from 'react-bootstrap-icons'
import type { components } from '../../generated/api.ts'

type Plan = readonly components['schemas']['PlanStep'][]

/** The step being worked on, which is the one worth showing when the rest is closed. */
function current(plan: Plan): { readonly step: Plan[number]; readonly at: number } | undefined {
  const at = plan.findIndex((step) => step.state === 'doing')
  const step = plan[at]

  return step === undefined ? undefined : { step, at }
}

function done(plan: Plan): number {
  return plan.filter((step) => step.state === 'done').length
}

export function ChatPlan({ plan }: { readonly plan: Plan }) {
  const [open, setOpen] = useState(false)
  const doing = current(plan)
  const finished = done(plan)

  return (
    <section className="chat-plan" aria-label="Plan">
      <button
        className="chat-plan-summary"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was)
        }}
      >
        {open ? <CaretDownFill aria-hidden /> : <CaretRightFill aria-hidden />}
        <span className="chat-plan-count">
          {finished} of {plan.length}
        </span>
        {/* The step itself and not the word "working": a label that says nothing about what is
            happening is the third thing these write-ups warn against. */}
        <span className="chat-plan-current">{doing?.step.text ?? 'Nothing under way'}</span>
      </button>

      {open && (
        <ol className="chat-plan-steps">
          {plan.map((step, at) => (
            <li
              key={`${at}-${step.text}`}
              className="chat-plan-step"
              data-state={step.state}
              aria-current={step.state === 'doing' ? 'step' : undefined}
            >
              {step.state === 'done' ? <CheckCircleFill aria-hidden /> : <Circle aria-hidden />}
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
