/**
 * Who is in this Space, and the two things an owner does about it: change what somebody may do,
 * and take somebody out.
 *
 * Taking somebody out is not here. It is a screen of its own — see `member-removal.tsx` — because
 * it is the one action in this product that asks a person to decide something first: what they
 * still hold has to go somewhere before their way in stops working.
 */

import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { PersonDash } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import type { components } from '../../generated/api.ts'
import { InvitationLinks } from './invitation-links.tsx'
import { RemovalChecklist } from './member-removal.tsx'
import { peopleIn, useChangeRole } from './people.ts'

type Member = components['schemas']['Member']

export function SpacePeople({
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
    <section aria-labelledby="space-people-title">
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
        id="space-people-title"
        className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-panel-ink"
      >
        People
      </h1>
      <p className="mt-1 text-[14px] leading-5 text-panel-ink-soft">
        Manage people in this Space and what they may do.
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
      <h2 id="members-title" className="mb-2 text-[14px] leading-5 font-medium text-panel-ink">
        Members <span className="font-normal text-panel-ink-quiet">{people.length}</span>
      </h2>
      <ul className="m-0 list-none divide-y divide-panel-line border-y border-panel-line p-0">
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
      {change.isError && <RoleError thrown={change.error} />}
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
      <span className="min-w-0 grow truncate text-[14px] font-medium text-panel-ink">
        {person.displayName}
        {person.you && <span className="ml-1 font-normal text-panel-ink-quiet">You</span>}
      </span>
      {isOwner ? (
        <select
          className="h-8 rounded-[5px] border border-transparent bg-transparent px-2 text-[13px] text-panel-ink-soft hover:bg-panel-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
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
        <span className="text-[13px] capitalize text-panel-ink-muted">{person.role}</span>
      )}
      {canRemove && (
        <button
          className="flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-panel-ink-muted hover:bg-panel-fill hover:text-panel-danger-quiet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          type="button"
          aria-label={person.you ? 'Leave this Space' : `Remove ${person.displayName}`}
          onClick={remove}
        >
          <PersonDash aria-hidden />
        </button>
      )}
    </li>
  )
}

/**
 * Why a role did not change.
 *
 * The last line is the one that matters: what a dropped connection throws is not a refusal at
 * all, and reading one as the other told somebody they were not allowed to do a thing they are
 * perfectly allowed to do. Named reasons come from `member-api.ts`.
 */
function whyTheRoleStands(thrown: unknown): string {
  const reason = reasonOf(thrown)
  if (reason === 'the-last-owner') return 'A Space keeps an owner. Make somebody else one first.'
  if (reason === 'not-an-owner') return 'Only an owner can change what somebody may do here.'

  return 'That could not be sent. Try again.'
}

function RoleError({ thrown }: { readonly thrown: unknown }) {
  return (
    <p className="mt-3 text-[13px] text-panel-danger" role="alert">
      {whyTheRoleStands(thrown)}
    </p>
  )
}

function PanelState({ children }: { readonly children: ReactNode }) {
  return (
    <p className="py-10 text-center text-[14px] text-panel-ink-muted" role="status">
      {children}
    </p>
  )
}
