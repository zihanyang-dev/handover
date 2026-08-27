/**
 * Who is in this Space, and the two things an owner does about that.
 *
 * One screen rather than two, because "ask somebody in" and "who is already in" are the same
 * question asked a second apart — and a person who has just sent a link comes straight back here
 * to see whether it was used.
 *
 * A member sees the list and nothing else. Not a disabled button, not a greyed row: the endpoints
 * behind those refuse a member anyway, so showing them would be offering something that cannot
 * happen. `prd.md` 05 ④.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { PersonPlus } from 'react-bootstrap-icons'
import { api } from '../../api.ts'
import { Copy } from '../copy.tsx'
import { Held } from './held.tsx'

type Member = {
  userId: string
  displayName: string
  role: 'owner' | 'member'
  since: string
  you: boolean
}

function peopleIn(slug: string) {
  return {
    queryKey: ['members', slug] as const,
    queryFn: async (): Promise<readonly Member[]> => {
      const { data, error } = await api.GET('/spaces/{slug}/members', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)

      return data.members
    },
  }
}

export function People({ slug }: { readonly slug: string }) {
  const heading = useId()
  const people = useQuery(peopleIn(slug))
  const here = people.data ?? []
  // What this reader may do, taken from the list itself rather than asked for separately: the
  // answer is already on the row that says `you`, and a second question could disagree with it.
  const yours = here.find((one) => one.you)

  return (
    <>
      {yours?.role === 'owner' && <Asking slug={slug} />}

      <section className="panel" aria-labelledby={heading}>
        <div className="panel-head">
          <h2 id={heading}>People</h2>
          {here.length > 0 && <span className="chip">{here.length}</span>}
        </div>

        {/* Three different things. A read that failed is not an empty Space, and a Space is never
            empty anyway — whoever made it is in it. */}
        {people.isError && <p className="empty">Could not read who is here. Try again.</p>}
        {people.isPending && <p className="empty">Looking…</p>}

        <ul className="rows">
          {here.map((one) => (
            <li key={one.userId} className="row">
              <span className="row-name">
                <strong>{one.displayName}</strong>
                {one.you && <span className="note">you</span>}
                {one.role === 'owner' && <span className="chip">Owner</span>}
              </span>

              {yours?.role === 'owner' && (
                <Aboutlate
                  slug={slug}
                  member={one}
                  others={here.filter((other) => other.userId !== one.userId)}
                  alone={here.length === 1}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

/**
 * What an owner can do about one person.
 *
 * Leaving is the same door as removing, aimed at yourself, so this row says "Leave" rather than
 * "Remove" when it is your own — the same request, and a different word because they are not the
 * same thing to the person pressing it.
 */
function Aboutlate({
  slug,
  member,
  others,
  alone,
}: {
  readonly slug: string
  readonly member: Member
  /** Everybody else here, for the rows on the checklist that can be handed to somebody. */
  readonly others: readonly Member[]
  readonly alone: boolean
}) {
  const client = useQueryClient()
  const [leaving, setLeaving] = useState(false)

  const moving = useMutation({
    mutationFn: async (role: 'owner' | 'member') => {
      const { response } = await api.PATCH('/spaces/{slug}/members/{userId}', {
        params: { path: { slug, userId: member.userId } },
        body: { role },
      })
      if (!response.ok) throw new Error(String(response.status))
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: ['members', slug] }),
  })

  return (
    <span className="beside">
      {/* The last person here has nobody to hand it to, and no reason to be offered the choice:
          a Space of one is already exactly as owned as it can be. */}
      {!alone && (
        <button
          className="button-quiet"
          type="button"
          disabled={moving.isPending}
          onClick={() => {
            moving.mutate(member.role === 'owner' ? 'member' : 'owner')
          }}
        >
          {member.role === 'owner' ? 'Make a member' : 'Make an owner'}
        </button>
      )}

      <button
        className="button-quiet"
        type="button"
        onClick={() => {
          setLeaving(true)
        }}
      >
        {member.you ? 'Leave' : 'Remove'}
      </button>

      {leaving && (
        <Held
          slug={slug}
          member={member}
          others={others}
          close={() => {
            setLeaving(false)
          }}
        />
      )}
    </span>
  )
}

/**
 * Making a link, and what is said about it.
 *
 * The plaintext exists for exactly as long as this screen holds it. Reloading loses it, and that
 * is not a bug to fix — it is the same shape as a machine's key, and it is what "only its hash is
 * kept" means from where somebody is standing.
 */
function Asking({ slug }: { readonly slug: string }) {
  const heading = useId()
  const [link, setLink] = useState<string | undefined>(undefined)

  const asking = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/spaces/{slug}/invitations', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)

      return data.link
    },
    onSuccess: setLink,
  })

  return (
    <section className="panel" aria-labelledby={heading}>
      <div className="panel-head">
        <h2 id={heading}>Ask somebody in</h2>
      </div>

      {link === undefined ? (
        <>
          <p className="empty">A link anybody who holds it can join with. Send it to one person.</p>
          <button
            className="button button-primary"
            type="button"
            disabled={asking.isPending}
            onClick={() => {
              asking.mutate()
            }}
          >
            <PersonPlus aria-hidden /> Make a link
          </button>
          {asking.isError && <p className="empty">Could not make one. Try again.</p>}
        </>
      ) : (
        <>
          <div className="shell-snippet">
            <code>{link}</code>
            <Copy text={link} what="link" />
          </div>
          {/* Said here rather than in a help page, because it is the one thing about this link
              that somebody could get wrong: it is not addressed to anybody. */}
          <p className="empty">
            Anybody holding this link can join. It stops working in seven days, and this is the only
            time it is shown.
          </p>
        </>
      )}
    </section>
  )
}
