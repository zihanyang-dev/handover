import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { components } from '../../generated/api.ts'
import { useHandWorkTo, useTakeBack } from '../conversations/work.ts'
import { useHandMachineTo } from '../machines/machine-list.ts'
import { useRemoveMember, whatTheyHold } from './people.ts'

type Member = components['schemas']['Member']
type Held = components['schemas']['StillTheirs']

/** The checklist before access is removed: every remaining responsibility stays a human choice. */
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
  const clear = held.data?.working.length === 0 && held.data.machines.length === 0

  return (
    <section aria-labelledby="remove-person-title">
      <button
        className="mb-4 border-0 bg-transparent text-[13px] text-[#777570] hover:text-[#373633]"
        type="button"
        onClick={back}
      >
        ← Back to people
      </button>
      <h2 id="remove-person-title" className="text-[18px] leading-6 font-semibold text-[#2f2e2b]">
        {person.you ? 'Leave this workspace' : `Remove ${person.displayName}`}
      </h2>
      <p className="mt-1 text-[13px] leading-[18px] text-[#777570]">
        Resolve everything still held here before access is removed. Nothing is moved or stopped
        automatically.
      </p>
      {held.isPending && <PanelState>Checking what they still hold…</PanelState>}
      {held.isError && <PanelState>Could not read what they still hold. Try again.</PanelState>}
      {held.data !== undefined && (
        <HeldRows slug={slug} held={held.data} recipients={recipients} changed={held.refetch} />
      )}
      <div className="mt-6 flex items-center justify-end gap-2 border-t border-[#e9e8e6] pt-4">
        <button
          className="h-8 rounded-[6px] border-0 bg-transparent px-3 text-[13px] font-medium hover:bg-[#f4f3f1]"
          type="button"
          onClick={back}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-[6px] border-0 bg-[#d44c47] px-3 text-[13px] font-medium text-white hover:bg-[#c33f3a] disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          disabled={!clear || remove.isPending}
          onClick={() => {
            remove.mutate(
              { params: { path: { slug, userId: person.userId } } },
              { onSuccess: removed },
            )
          }}
        >
          {person.you ? 'Leave workspace' : 'Remove member'}
        </button>
      </div>
      {remove.isError && <RemovalError reason={remove.error.reason} />}
    </section>
  )
}

function HeldRows({
  slug,
  held,
  recipients,
  changed,
}: {
  readonly slug: string
  readonly held: Held
  readonly recipients: readonly Member[]
  readonly changed: () => Promise<unknown>
}) {
  if (held.working.length === 0 && held.machines.length === 0)
    return (
      <p className="mt-5 rounded-[7px] bg-[#f7f6f4] p-3 text-[13px] text-[#5f5d59]">
        Nothing is still theirs here.
      </p>
    )

  return (
    <div className="mt-5 space-y-5">
      {held.working.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-[#5f5d59]">Pieces of work</h3>
          <ul className="m-0 list-none divide-y divide-[#e9e8e6] border-y border-[#e9e8e6] p-0">
            {held.working.map((work) => (
              <WorkResolution
                key={work.conversationId}
                slug={slug}
                work={work}
                recipients={recipients}
                changed={changed}
              />
            ))}
          </ul>
        </div>
      )}
      {held.machines.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-[#5f5d59]">Machines</h3>
          <ul className="m-0 list-none divide-y divide-[#e9e8e6] border-y border-[#e9e8e6] p-0">
            {held.machines.map((machine) => (
              <MachineResolution
                key={machine.id}
                slug={slug}
                machine={machine}
                recipients={recipients}
                changed={changed}
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
  changed,
}: {
  readonly slug: string
  readonly work: Held['working'][number]
  readonly recipients: readonly Member[]
  readonly changed: () => Promise<unknown>
}) {
  const transfer = useHandWorkTo(slug, work.conversationId)
  const stop = useTakeBack(slug, work.conversationId)
  const readHeldAgain = () => {
    void changed()
  }

  return (
    <li className="py-3">
      <p className="text-[13px] font-medium text-[#373633]">{work.goal}</p>
      <p className="mt-0.5 text-[12px] text-[#898781]">
        {work.state} · {work.machineName}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TransferChoice
          people={recipients}
          pending={transfer.isPending}
          act={(ownerUserId) => {
            transfer.mutate(
              { params: { path: { slug, id: work.conversationId } }, body: { ownerUserId } },
              { onSuccess: readHeldAgain },
            )
          }}
        />
        <SmallButton
          label="Stop work"
          danger
          disabled={stop.isPending}
          act={() => {
            stop.mutate(undefined, { onSuccess: readHeldAgain })
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
  changed,
}: {
  readonly slug: string
  readonly machine: Held['machines'][number]
  readonly recipients: readonly Member[]
  readonly changed: () => Promise<unknown>
}) {
  const transfer = useHandMachineTo(slug)
  const readHeldAgain = () => {
    void changed()
  }

  return (
    <li className="py-3">
      <p className="text-[13px] font-medium text-[#373633]">{machine.name}</p>
      <p className="mt-0.5 text-[12px] text-[#898781]">
        {machine.inUse === 0 ? 'Not in use' : `${machine.inUse} active conversations`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TransferChoice
          people={recipients}
          pending={transfer.isPending}
          act={(ownerUserId) => {
            transfer.mutate(
              { params: { path: { slug, id: machine.id } }, body: { ownerUserId } },
              { onSuccess: readHeldAgain },
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

  return (
    <>
      <select
        className="h-8 max-w-[220px] rounded-[5px] border border-[#d7d5d2] bg-white px-2 text-[13px] text-[#5f5d59]"
        aria-label="New owner"
        value={ownerUserId}
        onChange={(event) => {
          setOwnerUserId(event.target.value)
        }}
      >
        {people.length === 0 && <option value="">No other member</option>}
        {people.map((person) => (
          <option key={person.userId} value={person.userId}>
            {person.displayName}
          </option>
        ))}
      </select>
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
  danger = false,
  disabled,
  act,
}: {
  readonly label: string
  readonly danger?: boolean
  readonly disabled: boolean
  readonly act: () => void
}) {
  return (
    <button
      className={
        danger
          ? 'h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-[#9b2c2c] hover:bg-[#fdf0ef] disabled:opacity-45'
          : 'h-8 rounded-[5px] border border-[#d7d5d2] px-2 text-[13px] font-medium text-[#4f4d49] hover:bg-[#f5f4f2] disabled:opacity-45'
      }
      type="button"
      disabled={disabled}
      onClick={act}
    >
      {label}
    </button>
  )
}

function RemovalError({ reason }: { readonly reason: string }) {
  const message =
    reason === 'last-owner'
      ? 'Make somebody else an owner before leaving or changing your role.'
      : 'That did not work. Try again.'
  return (
    <p className="mt-3 text-[13px] text-[#b42318]" role="alert">
      {message}
    </p>
  )
}

function PanelState({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="py-6 text-[13px] text-[#777570]" role="status">
      {children}
    </p>
  )
}
