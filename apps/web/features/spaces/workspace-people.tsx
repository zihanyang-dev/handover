import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PersonDash } from 'react-bootstrap-icons'
import type { components } from '../../generated/api.ts'
import { InvitationLinks } from './invitation-links.tsx'
import { RemovalChecklist } from './member-removal.tsx'
import { peopleIn, useChangeRole } from './people.ts'

type Member = components['schemas']['Member']

export function WorkspacePeople({
  slug,
  afterLeaving,
}: {
  readonly slug: string
  readonly afterLeaving: () => void
}) {
  const people = useQuery(peopleIn(slug))
  const [removing, setRemoving] = useState<Member>()
  const own = people.data?.find((person) => person.you)
  const isOwner = own?.role === 'owner'

  if (people.isPending) return <PanelState>Looking for people…</PanelState>
  if (people.isError) return <PanelState>Could not read the people here. Try again.</PanelState>

  return (
    <section aria-labelledby="workspace-people-title">
      <PanelHeading />
      {isOwner && <InvitationLinks slug={slug} />}
      {removing === undefined ? (
        <MemberList slug={slug} people={people.data} isOwner={isOwner} remove={setRemoving} />
      ) : (
        <RemovalChecklist
          slug={slug}
          person={removing}
          people={people.data}
          back={() => {
            setRemoving(undefined)
          }}
          removed={() => {
            setRemoving(undefined)
            if (removing.you) afterLeaving()
          }}
        />
      )}
    </section>
  )
}

function PanelHeading() {
  return (
    <header className="mb-8">
      <h1
        id="workspace-people-title"
        className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-[#2f2e2b]"
      >
        People
      </h1>
      <p className="mt-1 text-[14px] leading-5 text-[#666460]">
        Manage people in this workspace and what they may do.
      </p>
    </header>
  )
}

function MemberList({
  slug,
  people,
  isOwner,
  remove,
}: {
  readonly slug: string
  readonly people: readonly Member[]
  readonly isOwner: boolean
  readonly remove: (person: Member) => void
}) {
  const change = useChangeRole(slug)

  return (
    <section aria-labelledby="members-title">
      <h2 id="members-title" className="mb-2 text-[14px] leading-5 font-medium text-[#373633]">
        Members <span className="font-normal text-[#9a9893]">{people.length}</span>
      </h2>
      <ul className="m-0 list-none divide-y divide-[#e9e8e6] border-y border-[#e9e8e6] p-0">
        {people.map((person) => (
          <MemberRow
            key={person.userId}
            person={person}
            isOwner={isOwner}
            changing={change.isPending}
            changeRole={(role) => {
              change.mutate({
                params: { path: { slug, userId: person.userId } },
                body: { role },
              })
            }}
            remove={() => {
              remove(person)
            }}
          />
        ))}
      </ul>
      {change.isError && <RoleError reason={change.error.reason} />}
    </section>
  )
}

function MemberRow({
  person,
  isOwner,
  changing,
  changeRole,
  remove,
}: {
  readonly person: Member
  readonly isOwner: boolean
  readonly changing: boolean
  readonly changeRole: (role: 'owner' | 'member') => void
  readonly remove: () => void
}) {
  const canRemove = isOwner || person.you

  return (
    <li className="flex min-h-[52px] items-center gap-3 py-2">
      <img className="size-8 shrink-0 rounded-full" src={person.avatarUrl} alt="" />
      <span className="min-w-0 grow truncate text-[14px] font-medium text-[#373633]">
        {person.displayName}
        {person.you && <span className="ml-1 font-normal text-[#989691]">You</span>}
      </span>
      {isOwner ? (
        <select
          className="h-8 rounded-[5px] border border-transparent bg-transparent px-2 text-[13px] text-[#5f5d59] hover:bg-[#f4f3f1] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
          aria-label={`${person.displayName} role`}
          value={person.role}
          disabled={changing}
          onChange={(event) => {
            changeRole(event.target.value as 'owner' | 'member')
          }}
        >
          <option value="owner">Owner</option>
          <option value="member">Member</option>
        </select>
      ) : (
        <span className="text-[13px] capitalize text-[#777570]">{person.role}</span>
      )}
      {canRemove && (
        <button
          className="flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-[#777570] hover:bg-[#f4f3f1] hover:text-[#9b2c2c] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
          type="button"
          aria-label={person.you ? 'Leave workspace' : `Remove ${person.displayName}`}
          onClick={remove}
        >
          <PersonDash aria-hidden />
        </button>
      )}
    </li>
  )
}

function RoleError({ reason }: { readonly reason: string }) {
  const message =
    reason === 'last-owner'
      ? 'Make somebody else an owner before leaving or changing your role.'
      : 'Only an owner can change roles.'
  return (
    <p className="mt-3 text-[13px] text-[#b42318]" role="alert">
      {message}
    </p>
  )
}

function PanelState({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="py-10 text-center text-[14px] text-[#777570]" role="status">
      {children}
    </p>
  )
}
