import { ArrowRight, Check2Circle } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import type { components } from '../../generated/api.ts'
import { useSay } from './conversation.ts'
import { useHandOver } from './work.ts'

type Underway = components['schemas']['Underway']
export type ProposalStatus = 'available' | 'handed-over' | 'superseded' | 'underway'

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
        <span className="text-copy-xxs text-danger-strong" role="alert">
          Could not ask for a handover. Try again.
        </span>
      )}
      <button
        className="h-7 rounded-md border border-line-firm bg-white px-2.5 text-copy-xxs font-medium text-ink-secondary hover:bg-fill disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
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
  proposalSeq,
  goal,
  location,
  status,
}: {
  readonly slug: string
  readonly id: string
  readonly proposalSeq: number
  readonly goal: string
  readonly location: { readonly machine: string } | undefined
  readonly status: ProposalStatus
}) {
  const handOver = useHandOver(slug, id)
  const available = status === 'available'

  return (
    <article className="my-4 border-l-2 border-primary/40 py-1 pl-4" aria-label="Proposed handover">
      <p className="text-[13px] leading-5 font-medium text-ink-muted">Proposed handover</p>
      <p className="mt-1.5 text-copy-xs leading-5 font-medium text-ink">{goal}</p>
      <p className="mt-1.5 text-copy-xxs leading-4.25 text-ink-muted">
        Nothing carries on by itself until you confirm this goal.
      </p>
      {location !== undefined && (
        <p className="mt-1 text-copy-xxs leading-4.25 text-ink-quiet">{location.machine}</p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        {status === 'handed-over' && (
          <span className="inline-flex h-8 items-center gap-1.5 text-[13px] font-medium text-good">
            <Check2Circle aria-hidden /> Handed over
          </span>
        )}
        {status === 'superseded' && <span className="text-[13px] text-ink-quiet">Superseded</span>}
        {status === 'underway' && (
          <span className="text-[13px] text-ink-quiet">Another goal is underway</span>
        )}
        {available && (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md border-0 bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus max-lg:h-10"
            type="button"
            disabled={handOver.isPending}
            onClick={() => {
              handOver.mutate(proposalSeq)
            }}
          >
            Hand over <ArrowRight aria-hidden />
          </button>
        )}
      </div>
      {handOver.isError && (
        <p className="mt-3 text-[13px] text-danger-strong" role="alert">
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
