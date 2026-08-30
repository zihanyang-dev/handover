import { ArrowRight, Check2Circle } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import type { components } from '../../generated/api.ts'
import { useSay } from './talking.ts'
import { useHandOver } from './work.ts'

type Underway = components['schemas']['Underway']

const HANDOVER_REQUEST =
  'Restate the goal you would take over in one sentence, record it with `handover task new`, and wait for my confirmation. Do not start yet.'

/** The guaranteed way to ask an agent for the one-sentence goal a person can confirm. */
export function HandoverControl({
  slug,
  id,
  underway,
  working,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: Underway | undefined
  readonly working: boolean
}) {
  const say = useSay(slug, id)
  if (underway !== undefined || working) return null

  return (
    <div className="ml-auto flex items-center gap-2">
      {say.isError && (
        <span className="text-[12px] text-panel-danger" role="alert">
          Could not ask for a handover. Try again.
        </span>
      )}
      <button
        className="h-7 rounded-[6px] border border-panel-line-firm bg-white px-2.5 text-[12px] font-medium text-panel-ink-soft hover:bg-panel-fill disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        type="button"
        disabled={say.isPending}
        onClick={() => {
          say.mutate({ text: HANDOVER_REQUEST })
        }}
      >
        {say.isPending ? 'Asking…' : 'Prepare handover'}
      </button>
    </div>
  )
}

/** The agent's restatement: still only a message until the person confirms it. */
export function HandoverProposal({
  slug,
  id,
  goal,
  active,
  available,
}: {
  readonly slug: string
  readonly id: string
  readonly goal: string
  readonly active: boolean
  readonly available: boolean
}) {
  const handOver = useHandOver(slug, id)

  return (
    <article
      className="my-3 rounded-[10px] border border-panel-line bg-panel-ground p-4"
      aria-label="Proposed handover"
    >
      <p className="text-[12px] leading-4 font-medium tracking-[0.01em] text-panel-ink-quiet uppercase">
        Proposed handover
      </p>
      <p className="mt-2 text-[14px] leading-5 font-medium text-panel-ink">{goal}</p>
      <p className="mt-2 text-[12px] leading-[17px] text-panel-ink-muted">
        Nothing carries on by itself until you confirm this goal.
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        {active && (
          <span className="inline-flex h-8 items-center gap-1.5 text-[13px] font-medium text-panel-good">
            <Check2Circle aria-hidden /> Handed over
          </span>
        )}
        {!active && !available && (
          <span className="text-[13px] text-panel-ink-quiet">Another goal is underway</span>
        )}
        {available && (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border-0 bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-200 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            type="button"
            disabled={handOver.isPending}
            onClick={() => {
              handOver.mutate(goal)
            }}
          >
            Hand over <ArrowRight aria-hidden />
          </button>
        )}
      </div>
      {handOver.isError && (
        <p className="mt-3 text-[13px] text-panel-danger" role="alert">
          {whyItDidNotGoOver(handOver.error)}
        </p>
      )}
    </article>
  )
}

/**
 * Why the goal was not taken on.
 *
 * The name is the server's own — `cannot-hand-over` in `task-api.ts` — and it covers both halves
 * of the one situation a person can act on: the agent is not there, or this proposal is not the
 * current one. What a dropped connection throws carries no reason at all, and calling that a
 * stale proposal would send somebody to ask for a new one that they do not need.
 */
function whyItDidNotGoOver(thrown: unknown): string {
  if (reasonOf(thrown) === 'cannot-hand-over')
    return 'That is no longer what is on offer here. Ask for it again.'

  return 'That could not be sent. Try again.'
}
