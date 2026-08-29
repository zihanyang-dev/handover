import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { BoxArrowUpRight, Clock, PersonCheck } from 'react-bootstrap-icons'
import type { components } from '../../generated/api.ts'
import { peopleIn } from '../spaces/people.ts'
import { useHandWorkTo, useTakeBack } from './work.ts'

type Underway = components['schemas']['Underway']

/** The durable projection beside a handed-over conversation: goal, state, children, and outputs. */
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
      className="h-full overflow-y-auto bg-[#fbfaf9] px-5 pt-5 pb-8"
      aria-labelledby="piece-of-work-title"
    >
      <WorkHeading close={close} />
      {underway.under !== null && <ParentWork slug={slug} under={underway.under} />}
      <p className="mt-4 text-[12px] font-medium tracking-[0.01em] text-[#898781] uppercase">
        Goal
      </p>
      <p className="mt-1 text-[14px] leading-5 font-medium text-[#343330]">{underway.goal}</p>
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
        <p className="mt-3 text-[12px] text-[#b42318]" role="alert">
          Could not take this work back. Try again.
        </p>
      )}
    </section>
  )
}

function WorkOwnership({ slug, id }: { readonly slug: string; readonly id: string }) {
  const people = useQuery(peopleIn(slug))
  const own = people.data?.find((person) => person.you)
  if (own?.role !== 'owner' || people.data === undefined || people.data.length === 0) return null

  return <WorkOwnerChoice slug={slug} id={id} recipients={people.data} />
}

function WorkOwnerChoice({
  slug,
  id,
  recipients,
}: {
  readonly slug: string
  readonly id: string
  readonly recipients: readonly components['schemas']['Member'][]
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
        <p className="mt-3 text-[12px] text-[#b42318]" role="alert">
          Could not transfer this work. Try again.
        </p>
      )}
    </>
  )
}

function WorkHeading({ close }: { readonly close: (() => void) | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id="piece-of-work-title" className="text-[16px] leading-6 font-semibold text-[#2f2e2b]">
        Piece of work
      </h2>
      {close !== undefined && (
        <button
          className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] text-[#777570] hover:bg-[#efeeec]"
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
      className="mt-3 flex items-center gap-1.5 rounded-[6px] bg-[#f0efed] px-2.5 py-2 text-[12px] text-[#5f5d59] hover:bg-[#e8e7e4]"
      to="/s/$slug/c/$id"
      params={{ slug, id: under.conversationId }}
    >
      <BoxArrowUpRight aria-hidden /> Part of {under.goal}
    </Link>
  )
}

function WorkState({ underway }: { readonly underway: Underway }) {
  return (
    <div className="mt-5 rounded-[7px] border border-[#e4e2de] bg-white p-3">
      <p className="flex items-center gap-2 text-[13px] font-medium text-[#454440]">
        <Clock className="text-[#898781]" aria-hidden /> {stateText(underway)}
      </p>
      {underway.presence.state === 'gone' && (
        <p className="mt-1 pl-6 text-[12px] leading-[17px] text-[#898781]">
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
  readonly recipients: readonly components['schemas']['Member'][]
  readonly ownerUserId: string
  readonly setOwnerUserId: (id: string) => void
  readonly transfer: ReturnType<typeof useHandWorkTo>
}) {
  return (
    <div className="mt-5 border-t border-[#e5e3df] pt-4">
      <label className="text-[12px] font-medium text-[#777570]">
        Responsible person
        <select
          className="mt-1 block h-8 w-full rounded-[5px] border border-[#d7d5d2] bg-white px-2 text-[13px] text-[#4f4d49]"
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
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-[#d7d5d2] bg-white px-2.5 text-[13px] font-medium text-[#4f4d49] hover:bg-[#f5f4f2] disabled:opacity-45"
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
    <section className="mt-5 border-t border-[#e5e3df] pt-4" aria-labelledby="handed-off-title">
      <h3
        id="handed-off-title"
        className="text-[12px] font-medium tracking-[0.01em] text-[#898781] uppercase"
      >
        Work it opened
      </h3>
      <ul className="mt-2 list-none space-y-1.5 p-0">
        {rows.map((row) => (
          <li key={row.conversationId}>
            <Link
              className="block rounded-[6px] border border-[#e4e2de] bg-white p-2.5 hover:bg-[#f7f6f4]"
              to="/s/$slug/c/$id"
              params={{ slug, id: row.conversationId }}
            >
              <strong className="block text-[13px] font-medium text-[#454440]">{row.goal}</strong>
              <span className="mt-0.5 block text-[12px] text-[#898781]">
                {row.state} · {row.machineName}
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
    <section className="mt-5 border-t border-[#e5e3df] pt-4" aria-labelledby="outputs-title">
      <h3
        id="outputs-title"
        className="text-[12px] font-medium tracking-[0.01em] text-[#898781] uppercase"
      >
        Outputs
      </h3>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <details
            className="rounded-[6px] border border-[#e4e2de] bg-white px-3 py-2 text-[13px]"
            key={row.title}
          >
            <summary className="cursor-pointer font-medium text-[#454440]">{row.title}</summary>
            <p className="mt-2 whitespace-pre-wrap text-[#5f5d59]">{row.body}</p>
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
    <div className="mt-6 border-t border-[#e5e3df] pt-4">
      {confirming ? (
        <div className="rounded-[7px] border border-[#f1cbc8] bg-[#fff7f6] p-3">
          <p className="text-[12px] leading-[17px] text-[#7d2925]">
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
              className="h-8 rounded-[5px] border-0 bg-[#d44c47] px-2.5 text-[13px] font-medium text-white disabled:opacity-45"
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
          className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-[#9b2c2c] hover:bg-[#fdf0ef]"
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
  return 'Finished'
}

function shortTime(at: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(at),
  )
}
