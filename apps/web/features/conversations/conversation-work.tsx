import { ArrowRight, Check2Circle } from 'react-bootstrap-icons'
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
        <span className="text-[12px] text-[#b42318]" role="alert">
          Could not ask for a handover. Try again.
        </span>
      )}
      <button
        className="h-7 rounded-[6px] border border-[#dedcd8] bg-white px-2.5 text-[12px] font-medium text-[#5f5d59] hover:bg-[#f7f6f4] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
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
      className="my-3 rounded-[10px] border border-[#ddd9d2] bg-[#fbfaf9] p-4"
      aria-label="Proposed handover"
    >
      <p className="text-[12px] leading-4 font-medium tracking-[0.01em] text-[#898781] uppercase">
        Proposed handover
      </p>
      <p className="mt-2 text-[14px] leading-5 font-medium text-[#343330]">{goal}</p>
      <p className="mt-2 text-[12px] leading-[17px] text-[#777570]">
        Nothing carries on by itself until you confirm this goal.
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        {active && (
          <span className="inline-flex h-8 items-center gap-1.5 text-[13px] font-medium text-[#4c7a4b]">
            <Check2Circle aria-hidden /> Handed over
          </span>
        )}
        {!active && !available && (
          <span className="text-[13px] text-[#898781]">Another goal is underway</span>
        )}
        {available && (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border-0 bg-[#2383e2] px-3 text-[13px] font-medium text-white hover:bg-[#1f75ca] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0075de]"
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
        <p className="mt-3 text-[13px] text-[#b42318]" role="alert">
          {handoverFailure(handOver.error.reason)}
        </p>
      )}
    </article>
  )
}

function handoverFailure(reason: string): string {
  if (reason === 'nothing-to-hand-over')
    return 'This proposal is no longer available. Ask for a new one.'
  return 'Could not hand this over. Try again.'
}
