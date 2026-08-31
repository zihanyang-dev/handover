/**
 * Who is in this Space, and the two things an owner does about it: change what somebody may do,
 * and take somebody out.
 *
 * Taking somebody out is not here. It is a screen of its own — see `member-removal.tsx` — because
 * it is the one action in this product that asks a person to decide something first: what they
 * still hold has to go somewhere before their way in stops working.
 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { reasonOf } from '../../api.ts'
import { MenuSelect } from '../../components/ui/menu-select.tsx'
import { SettingsHeading } from '../../components/ui/settings-heading.tsx'
import type { components } from '../../generated/api.ts'
import { InvitationLinks, type RevealedInvitation } from './invitation-links.tsx'
import { RemovalChecklist } from './member-removal.tsx'
import { peopleIn, useChangeRole } from './people.ts'

type Member = components['schemas']['Member']

const ROLES = [
  { value: 'owner', label: 'Owner' },
  { value: 'member', label: 'Member' },
] as const

export function SpacePeople({
  slug,
  afterLeaving,
  revealedInvitation,
  revealInvitation,
}: {
  readonly slug: string
  readonly afterLeaving: () => void
  readonly revealedInvitation: RevealedInvitation | undefined
  readonly revealInvitation: (invitation: RevealedInvitation | undefined) => void
}) {
  const people = useQuery(peopleIn(slug))
  const [removing, setRemoving] = useState<Member>()
  const own = people.data?.find((person) => person.you)
  const isOwner = own?.role === 'owner'

  if (people.isPending)
    return (
      <p className="py-10 text-center text-[14px] text-ink-muted" role="status">
        Looking for people…
      </p>
    )
  if (people.isError)
    return (
      <p className="py-10 text-center text-[14px] text-ink-muted" role="alert">
        Could not read the people here. Try again.
      </p>
    )

  return (
    <section aria-labelledby="space-people-title">
      <SettingsHeading id="space-people-title" title="People" />
      {isOwner && (
        <InvitationLinks
          slug={slug}
          revealed={revealedInvitation}
          reveal={revealInvitation}
          forget={() => {
            revealInvitation(undefined)
          }}
        />
      )}
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
      <h2 id="members-title" className="m-0 mb-2 text-[14px] leading-5 font-medium text-ink">
        Members <span className="font-normal text-ink-quiet">{people.length}</span>
      </h2>
      <ul className="m-0 list-none space-y-1 p-0">
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
  const dangerAction = canRemove
    ? { label: person.you ? 'Leave Space' : 'Remove from Space', choose: remove }
    : undefined

  return (
    <li className="flex min-h-[52px] items-center gap-3 py-2">
      <img className="size-8 shrink-0 rounded-full" src={person.avatarUrl} alt="" />
      <span className="min-w-0 grow truncate text-[14px] font-medium text-ink">
        {person.displayName}
        {person.you && <span className="ml-1 font-normal text-ink-quiet">You</span>}
      </span>
      {isOwner ? (
        <MenuSelect
          label={`${person.displayName} role`}
          value={person.role}
          choices={ROLES}
          disabled={changing}
          onChange={changeRole}
          dangerAction={dangerAction}
        />
      ) : (
        <>
          <span className="text-[13px] capitalize text-ink-muted">{person.role}</span>
          {canRemove && (
            <button
              className="h-7 rounded-[5px] border-0 bg-transparent px-2 text-[13px] text-ink-muted hover:bg-danger-wash hover:text-danger-quiet focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
              type="button"
              onClick={remove}
            >
              Leave Space
            </button>
          )}
        </>
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
    <p className="mt-3 text-[13px] text-danger-strong" role="alert">
      {whyTheRoleStands(thrown)}
    </p>
  )
}
