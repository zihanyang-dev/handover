/**
 * What has to be settled before somebody's way in stops working.
 *
 * The one screen in this product that refuses to act until a person has decided something. Their
 * machines go with them and their pieces of work stop, and neither is something this can choose
 * for them — so each one is listed, each one is moved or stopped by hand, and the button stays
 * disabled until nothing is left. Tailscale's lesson, the other way round: deleting a user there
 * deletes their devices and everything running on them, with no list and no pause.
 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { reasonOf } from '../../api.ts'
import { MenuSelect } from '../../components/ui/menu-select.tsx'
import type { components } from '../../generated/api.ts'
import { useHandWorkTo, useTakeBack, whatItIsDoing } from '../conversations/work.ts'
import { useHandMachineTo } from '../machines/machine-list.ts'
import { useRemoveMember, whatTheyHold } from './people.ts'

type Member = components['schemas']['Member']
type Held = components['schemas']['StillTheirs']

export function RemovalChecklist({
  slug,
  person,
  people,
  back,
  removed,
}: {
  readonly slug: string
  readonly person: Member
  readonly people: readonly Member[]
  readonly back: () => void
  readonly removed: () => void
}) {
  const held = useQuery(whatTheyHold(slug, person.userId))
  const remove = useRemoveMember(slug)
  const recipients = people.filter((candidate) => candidate.userId !== person.userId)
  // Not yet read is not the same as nothing left, and this is the guard on the one button that
  // cannot be undone: until the answer is here it stays as though something were still held.
  const holdsNothing = held.data !== undefined && nothingLeft(held.data)

  return (
    <section aria-labelledby="remove-person-title">
      <button
        className="mb-4 border-0 bg-transparent text-[13px] text-ink-muted hover:text-ink"
        type="button"
        onClick={back}
      >
        ← Back to people
      </button>
      <h2 id="remove-person-title" className="text-[18px] leading-6 font-semibold text-ink">
        {person.you ? 'Leave this Space' : `Remove ${person.displayName}`}
      </h2>
      <p className="mt-1 text-[13px] leading-[18px] text-ink-muted">
        Resolve everything still held here before access is removed. Nothing is moved or stopped
        automatically.
      </p>
      {held.isPending && (
        <p className="py-6 text-[13px] text-ink-muted" role="status">
          Checking what they still hold…
        </p>
      )}
      {held.isError && (
        <p className="py-6 text-[13px] text-ink-muted" role="alert">
          Could not read what they still hold. Try again.
        </p>
      )}
      {held.data !== undefined && (
        <HeldRows
          slug={slug}
          held={held.data}
          recipients={recipients}
          readAgain={() => {
            void held.refetch()
          }}
        />
      )}
      <div className="mt-6 flex items-center justify-end gap-2 pt-4">
        <button
          className="h-8 rounded-[6px] border-0 bg-transparent px-3 text-[13px] font-medium hover:bg-fill"
          type="button"
          onClick={back}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-[6px] border-0 bg-danger-fill px-3 text-[13px] font-medium text-white hover:bg-danger-fill-hover disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          disabled={!holdsNothing || remove.isPending}
          onClick={() => {
            remove.mutate(
              { params: { path: { slug, userId: person.userId } } },
              { onSuccess: removed },
            )
          }}
        >
          {person.you ? 'Leave this Space' : 'Remove member'}
        </button>
      </div>
      {remove.isError && <RemovalError thrown={remove.error} />}
    </section>
  )
}

/** Whether there is anything left to settle, asked the one way, by both readers of the answer. */
function nothingLeft(held: Held): boolean {
  return held.working.length === 0 && held.machines.length === 0
}

function HeldRows({
  slug,
  held,
  recipients,
  readAgain,
}: {
  readonly slug: string
  readonly held: Held
  readonly recipients: readonly Member[]
  readonly readAgain: () => void
}) {
  if (nothingLeft(held))
    return (
      <p className="mt-5 rounded-[7px] bg-fill p-3 text-[13px] text-ink-secondary">
        Nothing is still theirs here.
      </p>
    )

  return (
    <div className="mt-5 space-y-5">
      {held.working.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-ink-secondary">Pieces of work</h3>
          <ul className="m-0 list-none space-y-1 p-0">
            {held.working.map((work) => (
              <WorkResolution
                key={work.conversationId}
                slug={slug}
                work={work}
                recipients={recipients}
                readAgain={readAgain}
              />
            ))}
          </ul>
        </div>
      )}
      {held.machines.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-ink-secondary">Machines</h3>
          <ul className="m-0 list-none space-y-1 p-0">
            {held.machines.map((machine) => (
              <MachineResolution
                key={machine.id}
                slug={slug}
                machine={machine}
                recipients={recipients}
                readAgain={readAgain}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function WorkResolution({
  slug,
  work,
  recipients,
  readAgain,
}: {
  readonly slug: string
  readonly work: Held['working'][number]
  readonly recipients: readonly Member[]
  readonly readAgain: () => void
}) {
  const transfer = useHandWorkTo(slug, work.conversationId)
  const stop = useTakeBack(slug, work.conversationId)

  return (
    <li className="py-3">
      <p className="text-[13px] font-medium text-ink">{work.goal}</p>
      <p className="mt-0.5 text-[12px] text-ink-quiet">
        {whatItIsDoing(work.state)} · {work.machineName}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TransferChoice
          people={recipients}
          pending={transfer.isPending}
          act={(ownerUserId) => {
            transfer.mutate(
              { params: { path: { slug, id: work.conversationId } }, body: { ownerUserId } },
              { onSuccess: readAgain },
            )
          }}
        />
        <SmallButton
          label="Stop work"
          isDestructive
          disabled={stop.isPending}
          act={() => {
            stop.mutate(undefined, { onSuccess: readAgain })
          }}
        />
      </div>
    </li>
  )
}

function MachineResolution({
  slug,
  machine,
  recipients,
  readAgain,
}: {
  readonly slug: string
  readonly machine: Held['machines'][number]
  readonly recipients: readonly Member[]
  readonly readAgain: () => void
}) {
  const transfer = useHandMachineTo(slug)

  return (
    <li className="py-3">
      <p className="text-[13px] font-medium text-ink">{machine.name}</p>
      <p className="mt-0.5 text-[12px] text-ink-quiet">
        {machine.inUse === 0 ? 'Not in use' : `${machine.inUse} active conversations`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TransferChoice
          people={recipients}
          pending={transfer.isPending}
          act={(ownerUserId) => {
            transfer.mutate(
              { params: { path: { slug, id: machine.id } }, body: { ownerUserId } },
              { onSuccess: readAgain },
            )
          }}
        />
      </div>
    </li>
  )
}

function TransferChoice({
  people,
  pending,
  act,
}: {
  readonly people: readonly Member[]
  readonly pending: boolean
  readonly act: (userId: string) => void
}) {
  const [ownerUserId, setOwnerUserId] = useState(people[0]?.userId ?? '')
  const choices = people.map((person) => ({ value: person.userId, label: person.displayName }))

  return (
    <>
      <div className="w-full max-w-[220px]">
        <MenuSelect
          label="New owner"
          value={ownerUserId}
          choices={choices.length === 0 ? [{ value: '', label: 'No other member' }] : choices}
          onChange={setOwnerUserId}
          disabled={choices.length === 0}
          stretch
        />
      </div>
      <SmallButton
        label="Transfer"
        disabled={ownerUserId === '' || pending}
        act={() => {
          act(ownerUserId)
        }}
      />
    </>
  )
}

function SmallButton({
  label,
  isDestructive = false,
  disabled,
  act,
}: {
  readonly label: string
  readonly isDestructive?: boolean
  readonly disabled: boolean
  readonly act: () => void
}) {
  return (
    <button
      className={
        isDestructive
          ? 'h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-danger-quiet hover:bg-danger-wash disabled:opacity-45'
          : 'h-8 rounded-[5px] border border-line-firm px-2 text-[13px] font-medium text-ink-body hover:bg-fill disabled:opacity-45'
      }
      type="button"
      disabled={disabled}
      onClick={act}
    >
      {label}
    </button>
  )
}

/**
 * Why nobody was taken out.
 *
 * The name is the server's own — `the-last-owner` in `member-api.ts`. What a dropped connection
 * throws carries no reason at all, and reading one as the other told the last owner of a Space
 * something true, and told everybody else the same thing when it was not.
 */
function whyTheyAreStillHere(thrown: unknown): string {
  if (reasonOf(thrown) === 'the-last-owner')
    return 'A Space keeps an owner. Make somebody else one first.'

  return 'That could not be sent. Try again.'
}

function RemovalError({ thrown }: { readonly thrown: unknown }) {
  return (
    <p className="mt-3 text-[13px] text-danger-strong" role="alert">
      {whyTheyAreStillHere(thrown)}
    </p>
  )
}
