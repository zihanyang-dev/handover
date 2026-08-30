/**
 * What a conversation carries once nobody is sitting in it: the goal, where it has got to, what it
 * opened, what it wrote down, and the two things a person may do about it.
 *
 * Everything shown here is the ledger, never the transcript. The transcript says when a thing
 * happened; this says what is true now, and the two are written in the same transaction — see
 * `conversation/transcript.ts`.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { BoxArrowUpRight, Clock, PersonCheck } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import type { components } from '../../generated/api.ts'
import { peopleIn } from '../spaces/people.ts'
import { useHandWorkTo, useTakeBack, whatItIsDoing } from './work.ts'

type Underway = components['schemas']['Underway']

type Member = components['schemas']['Member']

export function WorkPanel({
  slug,
  id,
  underway,
  close,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: Underway
  readonly close?: () => void
}) {
  const takeBack = useTakeBack(slug, id)
  const [confirming, setConfirming] = useState(false)

  return (
    <section
      className="h-full overflow-y-auto bg-panel-ground px-5 pt-5 pb-8"
      aria-labelledby="piece-of-work-title"
    >
      <WorkHeading close={close} />
      {underway.under !== null && <ParentWork slug={slug} under={underway.under} />}
      <p className="mt-4 text-[12px] font-medium tracking-[0.01em] text-panel-ink-quiet uppercase">
        Goal
      </p>
      <p className="mt-1 text-[14px] leading-5 font-medium text-panel-ink">{underway.goal}</p>
      <WorkState underway={underway} />
      <WorkOwnership slug={slug} id={id} />
      <HandedOff slug={slug} rows={underway.handedOff} />
      <Outputs rows={underway.outputs} />
      <TakeBack
        confirming={confirming}
        setConfirming={setConfirming}
        pending={takeBack.isPending}
        act={() => {
          takeBack.mutate()
        }}
      />
      {takeBack.isError && (
        <p className="mt-3 text-[12px] text-panel-danger" role="alert">
          That could not be sent. Try again.
        </p>
      )}
    </section>
  )
}

/**
 * Who answers for this, which only an owner may change.
 *
 * Nothing at all until the list is here and says this person is one: an owner is found *in* that
 * list, so there is no state where the answer is yes and the list is missing.
 */
function WorkOwnership({ slug, id }: { readonly slug: string; readonly id: string }) {
  const people = useQuery(peopleIn(slug))
  if (people.data?.find((person) => person.you)?.role !== 'owner') return null

  return <WorkOwnerChoice slug={slug} id={id} recipients={people.data} />
}

function WorkOwnerChoice({
  slug,
  id,
  recipients,
}: {
  readonly slug: string
  readonly id: string
  readonly recipients: readonly Member[]
}) {
  const transfer = useHandWorkTo(slug, id)
  const [ownerUserId, setOwnerUserId] = useState(recipients[0]?.userId ?? '')

  return (
    <>
      <TransferWork
        slug={slug}
        id={id}
        recipients={recipients}
        ownerUserId={ownerUserId}
        setOwnerUserId={setOwnerUserId}
        transfer={transfer}
      />
      {transfer.isError && (
        <p className="mt-3 text-[12px] text-panel-danger" role="alert">
          {whyItDidNotMove(transfer.error)}
        </p>
      )}
    </>
  )
}

function WorkHeading({ close }: { readonly close: (() => void) | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id="piece-of-work-title" className="text-[16px] leading-6 font-semibold text-panel-ink">
        Piece of work
      </h2>
      {close !== undefined && (
        <button
          className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] text-panel-ink-muted hover:bg-panel-line"
          type="button"
          onClick={close}
        >
          Close
        </button>
      )}
    </div>
  )
}

function ParentWork({
  slug,
  under,
}: {
  readonly slug: string
  readonly under: NonNullable<Underway['under']>
}) {
  return (
    <Link
      className="mt-3 flex items-center gap-1.5 rounded-[6px] bg-panel-fill-firm px-2.5 py-2 text-[12px] text-panel-ink-soft hover:bg-panel-fill-firm"
      to="/s/$slug/c/$id"
      params={{ slug, id: under.conversationId }}
    >
      <BoxArrowUpRight aria-hidden /> Part of {under.goal}
    </Link>
  )
}

function WorkState({ underway }: { readonly underway: Underway }) {
  return (
    <div className="mt-5 rounded-[7px] border border-panel-line bg-white p-3">
      <p className="flex items-center gap-2 text-[13px] font-medium text-panel-ink-body">
        <Clock className="text-panel-ink-quiet" aria-hidden /> {stateText(underway)}
      </p>
      {underway.presence.state === 'gone' && (
        <p className="mt-1 pl-6 text-[12px] leading-[17px] text-panel-ink-quiet">
          Its machine has been offline since {shortTime(underway.presence.since)}.
        </p>
      )}
    </div>
  )
}

function TransferWork({
  slug,
  id,
  recipients,
  ownerUserId,
  setOwnerUserId,
  transfer,
}: {
  readonly slug: string
  readonly id: string
  readonly recipients: readonly Member[]
  readonly ownerUserId: string
  readonly setOwnerUserId: (id: string) => void
  readonly transfer: ReturnType<typeof useHandWorkTo>
}) {
  return (
    <div className="mt-5 border-t border-panel-line pt-4">
      <label className="text-[12px] font-medium text-panel-ink-muted">
        Responsible person
        <select
          className="mt-1 block h-8 w-full rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] text-panel-ink-body"
          value={ownerUserId}
          onChange={(event) => {
            setOwnerUserId(event.target.value)
          }}
        >
          {recipients.map((person) => (
            <option key={person.userId} value={person.userId}>
              {person.displayName}
            </option>
          ))}
        </select>
      </label>
      <button
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-panel-line-firm bg-white px-2.5 text-[13px] font-medium text-panel-ink-body hover:bg-panel-fill disabled:opacity-45"
        type="button"
        disabled={ownerUserId === '' || transfer.isPending}
        onClick={() => {
          transfer.mutate({ params: { path: { slug, id } }, body: { ownerUserId } })
        }}
      >
        <PersonCheck aria-hidden /> Transfer responsibility
      </button>
    </div>
  )
}

function HandedOff({
  slug,
  rows,
}: {
  readonly slug: string
  readonly rows: Underway['handedOff']
}) {
  if (rows.length === 0) return null
  return (
    <section className="mt-5 border-t border-panel-line pt-4" aria-labelledby="handed-off-title">
      <h3
        id="handed-off-title"
        className="text-[12px] font-medium tracking-[0.01em] text-panel-ink-quiet uppercase"
      >
        Work it opened
      </h3>
      <ul className="mt-2 list-none space-y-1.5 p-0">
        {rows.map((row) => (
          <li key={row.conversationId}>
            <Link
              className="block rounded-[6px] border border-panel-line bg-white p-2.5 hover:bg-panel-fill"
              to="/s/$slug/c/$id"
              params={{ slug, id: row.conversationId }}
            >
              <strong className="block text-[13px] font-medium text-panel-ink-body">
                {row.goal}
              </strong>
              <span className="mt-0.5 block text-[12px] text-panel-ink-quiet">
                {whatItIsDoing(row.state)} · {row.machineName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Outputs({ rows }: { readonly rows: Underway['outputs'] }) {
  if (rows.length === 0) return null
  return (
    <section className="mt-5 border-t border-panel-line pt-4" aria-labelledby="outputs-title">
      <h3
        id="outputs-title"
        className="text-[12px] font-medium tracking-[0.01em] text-panel-ink-quiet uppercase"
      >
        Outputs
      </h3>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <details
            className="rounded-[6px] border border-panel-line bg-white px-3 py-2 text-[13px]"
            key={row.title}
          >
            <summary className="cursor-pointer font-medium text-panel-ink-body">
              {row.title}
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-panel-ink-soft">{row.body}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

function TakeBack({
  confirming,
  setConfirming,
  pending,
  act,
}: {
  readonly confirming: boolean
  readonly setConfirming: (value: boolean) => void
  readonly pending: boolean
  readonly act: () => void
}) {
  return (
    <div className="mt-6 border-t border-panel-line pt-4">
      {confirming ? (
        <div className="rounded-[7px] border border-panel-danger-line bg-panel-danger-notice p-3">
          <p className="text-[12px] leading-[17px] text-panel-danger-ink">
            This stops the work it is doing and every unfinished piece it handed off.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] hover:bg-white"
              type="button"
              onClick={() => {
                setConfirming(false)
              }}
            >
              Cancel
            </button>
            <button
              className="h-8 rounded-[5px] border-0 bg-panel-danger-fill px-2.5 text-[13px] font-medium text-white disabled:opacity-45"
              type="button"
              disabled={pending}
              onClick={act}
            >
              Take back work
            </button>
          </div>
        </div>
      ) : (
        <button
          className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-panel-danger-quiet hover:bg-panel-danger-wash"
          type="button"
          onClick={() => {
            setConfirming(true)
          }}
        >
          Take back
        </button>
      )}
    </div>
  )
}

/**
 * Where it has got to, in one sentence.
 *
 * Richer than the state on its own, and deliberately: three of the four say something a person
 * cannot act on without the thing beside them — a machine that is not there beats every state,
 * `working` while something it opened is unfinished means it is waiting rather than typing, and a
 * sleep that has a time is different from one that does not.
 *
 * `wait` is the one that changes wording here: on this panel it is *your* conversation, so it is
 * "waiting on you"; in a list of somebody else's it is `whatItIsDoing`'s plainer word.
 */
function stateText(underway: Underway): string {
  if (underway.presence.state === 'gone') return 'Its machine is offline'
  if (underway.state === 'working')
    return underway.handedOff.some((row) => row.state !== 'done')
      ? 'Waiting on work it opened'
      : 'Working'
  if (underway.state === 'wait') return 'Waiting on you'
  if (underway.state === 'sleep')
    return underway.sleepUntil === null
      ? 'Sleeping'
      : `Sleeping until ${shortTime(underway.sleepUntil)}`

  return whatItIsDoing(underway.state)
}

/** Named reasons come from `task-api.ts` and `member-api.ts`. */
function whyItDidNotMove(thrown: unknown): string {
  const reason = reasonOf(thrown)
  if (reason === 'not-an-owner') return 'Only an owner can change who answers for this.'
  if (reason === 'not-a-member') return 'That person is not in this Space any more.'

  return 'That could not be sent. Try again.'
}

function shortTime(at: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(at),
  )
}
