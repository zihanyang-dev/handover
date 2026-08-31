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
import { useEffect, useRef, useState, type RefObject } from 'react'
import { BoxArrowUpRight, PersonCheck } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import { MenuSelect } from '../../components/ui/menu-select.tsx'
import type { components } from '../../generated/api.ts'
import { peopleIn } from '../spaces/people.ts'
import { useHandWorkTo, useTakeBack, whatItIsDoing } from './work.ts'

type Underway = components['schemas']['Underway']

type Member = components['schemas']['Member']

export function WorkPanel({
  slug,
  id,
  underway,
  location,
  close,
  closeRef,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: Underway
  readonly location: { readonly machine: string } | undefined
  readonly close?: () => void
  readonly closeRef?: RefObject<HTMLButtonElement | null>
}) {
  const takeBack = useTakeBack(slug, id)

  return (
    <section
      className="h-full overflow-y-auto bg-white px-6 pt-6 pb-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-labelledby="piece-of-work-title"
    >
      <WorkHeading close={close} closeRef={closeRef} />
      {underway.under !== null && <ParentWork slug={slug} under={underway.under} />}
      <div className="mt-6">
        <p className="text-[13px] leading-5 font-medium text-ink-muted">Goal</p>
        <p className="mt-1.5 text-[15px] leading-[22px] font-medium text-ink">{underway.goal}</p>
      </div>
      {location !== undefined && (
        <p className="mt-2 text-[12px] leading-[17px] text-ink-quiet">{location.machine}</p>
      )}
      <WorkState underway={underway} />
      <WorkOwnership slug={slug} id={id} ownerUserId={underway.ownerUserId} />
      <HandedOff slug={slug} rows={underway.handedOff} />
      <Outputs rows={underway.outputs} />
      <TakeBack
        pending={takeBack.isPending}
        act={() => {
          takeBack.mutate()
        }}
      />
      {takeBack.isError && (
        <p className="mt-3 text-[12px] text-danger-strong" role="alert">
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
function WorkOwnership({
  slug,
  id,
  ownerUserId,
}: {
  readonly slug: string
  readonly id: string
  readonly ownerUserId: string
}) {
  const people = useQuery(peopleIn(slug))
  if (people.isError)
    return (
      <p className="mt-6 text-[12px] text-danger-strong" role="alert">
        Could not read who can take responsibility. Try again.
      </p>
    )
  if (people.data?.find((person) => person.you)?.role !== 'owner') return null
  if (!people.data.some((person) => person.userId !== ownerUserId)) return null

  return (
    <WorkOwnerChoice
      key={ownerUserId}
      slug={slug}
      id={id}
      currentOwnerUserId={ownerUserId}
      recipients={people.data}
    />
  )
}

function WorkOwnerChoice({
  slug,
  id,
  currentOwnerUserId,
  recipients,
}: {
  readonly slug: string
  readonly id: string
  readonly currentOwnerUserId: string
  readonly recipients: readonly Member[]
}) {
  const transfer = useHandWorkTo(slug, id)
  const [ownerUserId, setOwnerUserId] = useState(currentOwnerUserId)

  return (
    <>
      <TransferWork
        slug={slug}
        id={id}
        recipients={recipients}
        currentOwnerUserId={currentOwnerUserId}
        ownerUserId={ownerUserId}
        setOwnerUserId={setOwnerUserId}
        transfer={transfer}
      />
      {transfer.isError && (
        <p className="mt-3 text-[12px] text-danger-strong" role="alert">
          {whyItDidNotMove(transfer.error)}
        </p>
      )}
    </>
  )
}

function WorkHeading({
  close,
  closeRef,
}: {
  readonly close: (() => void) | undefined
  readonly closeRef: RefObject<HTMLButtonElement | null> | undefined
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id="piece-of-work-title" className="text-[18px] leading-6 font-semibold text-ink">
        Piece of work
      </h2>
      {close !== undefined && (
        <button
          ref={closeRef}
          className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] text-ink-muted hover:bg-line lg:hidden"
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
      className="mt-4 flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[12px] text-ink-muted hover:bg-fill"
      to="/s/$slug/c/$id"
      params={{ slug, id: under.conversationId }}
    >
      <BoxArrowUpRight aria-hidden /> Part of {under.goal}
    </Link>
  )
}

function WorkState({ underway }: { readonly underway: Underway }) {
  return (
    <div className="mt-4">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink-body">
        <span
          className={
            underway.presence.state === 'gone'
              ? 'size-1.5 rounded-full bg-ink-faint'
              : 'size-1.5 rounded-full bg-good-mark'
          }
          aria-hidden
        />
        {stateText(underway)}
      </p>
      {underway.presence.state === 'gone' && (
        <p className="mt-1 pl-3.5 text-[12px] leading-[17px] text-ink-quiet">
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
  currentOwnerUserId,
  ownerUserId,
  setOwnerUserId,
  transfer,
}: {
  readonly slug: string
  readonly id: string
  readonly recipients: readonly Member[]
  readonly currentOwnerUserId: string
  readonly ownerUserId: string
  readonly setOwnerUserId: (id: string) => void
  readonly transfer: ReturnType<typeof useHandWorkTo>
}) {
  return (
    <div className="mt-7">
      <div className="text-[12px] font-medium text-ink-muted">
        <span className="mb-1 block">Responsible person</span>
        <MenuSelect
          label="Responsible person"
          value={ownerUserId}
          choices={recipients.map((person) => ({
            value: person.userId,
            label: person.displayName,
          }))}
          onChange={setOwnerUserId}
          stretch
        />
      </div>
      <button
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[5px] border-0 bg-fill px-2.5 text-[13px] font-medium text-ink-body hover:bg-fill-firm disabled:opacity-45 max-lg:h-10"
        type="button"
        disabled={ownerUserId === '' || ownerUserId === currentOwnerUserId || transfer.isPending}
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
    <section className="mt-7" aria-labelledby="handed-off-title">
      <h3 id="handed-off-title" className="text-[13px] leading-5 font-medium text-ink-muted">
        Work it opened
      </h3>
      <ul className="mt-2 list-none space-y-1.5 p-0">
        {rows.map((row) => (
          <li key={row.conversationId}>
            <Link
              className="block rounded-[6px] px-2 py-2 hover:bg-fill"
              to="/s/$slug/c/$id"
              params={{ slug, id: row.conversationId }}
            >
              <strong className="block text-[13px] font-medium text-ink-body">{row.goal}</strong>
              <span className="mt-0.5 block text-[12px] text-ink-quiet">
                {handedOffState(row)} · {row.machineName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function handedOffState(row: Underway['handedOff'][number]): string {
  if (row.state !== 'done' && row.presence.state === 'gone') return 'Machine offline'
  return whatItIsDoing(row.state)
}

function Outputs({ rows }: { readonly rows: Underway['outputs'] }) {
  if (rows.length === 0) return null
  return (
    <section className="mt-7" aria-labelledby="outputs-title">
      <h3 id="outputs-title" className="text-[13px] leading-5 font-medium text-ink-muted">
        Outputs
      </h3>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <details className="rounded-[6px] bg-fill px-3 py-2 text-[13px]" key={row.title}>
            <summary className="cursor-pointer font-medium text-ink-body">{row.title}</summary>
            <p className="mt-2 whitespace-pre-wrap text-ink-secondary">{row.body}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

function TakeBack({ pending, act }: { readonly pending: boolean; readonly act: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirming) cancelButton.current?.focus()
  }, [confirming])

  const cancel = (): void => {
    setConfirming(false)
    requestAnimationFrame(() => {
      trigger.current?.focus()
    })
  }

  return (
    <div className="mt-8">
      {confirming ? (
        <div className="rounded-[7px] border border-danger-line bg-danger-notice p-3">
          <p className="text-[12px] leading-[17px] text-danger-ink">
            This stops the work it is doing and every unfinished piece it handed off.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              ref={cancelButton}
              className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] hover:bg-white max-lg:h-10"
              type="button"
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              className="h-8 rounded-[5px] border-0 bg-danger-fill px-2.5 text-[13px] font-medium text-white disabled:opacity-45 max-lg:h-10"
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
          ref={trigger}
          className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-danger-quiet hover:bg-danger-wash max-lg:h-10"
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
  if (reason === 'cannot-hand-over')
    return 'That person can no longer take this work here. Choose somebody who is still in the Space.'

  return 'That could not be sent. Try again.'
}

function shortTime(at: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(at),
  )
}
