/**
 * What is still theirs, shown before anybody is taken out.
 *
 * The point of this whole slice, and the reason removal is not a button: nothing here stops or
 * moves on its own. A turn that is running keeps running, a machine stays where it is, and what
 * gets left behind is whatever this list was not dealt with. `prd.md` 05 ⑥.
 *
 * Read every time it opens rather than kept: it is a list of things that are moving, and one read
 * a minute ago is a list of what *was* true — which is exactly the wrong thing to decide from.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { api } from '../../api.ts'

type Member = { userId: string; displayName: string; you: boolean }

function heldBy(slug: string, userId: string) {
  return {
    queryKey: ['held', slug, userId] as const,
    queryFn: async () => {
      const { data, error } = await api.GET('/spaces/{slug}/members/{userId}/held', {
        params: { path: { slug, userId } },
      })
      if (data === undefined) throw new Error(error.reason)

      return data
    },
  }
}

export function Held({
  slug,
  member,
  close,
}: {
  readonly slug: string
  readonly member: Member
  readonly close: () => void
}) {
  const heading = useId()
  const box = useRef<HTMLDialogElement>(null)
  const held = useQuery(heldBy(slug, member.userId))
  const client = useQueryClient()

  // Opened as a modal rather than rendered open, which is what makes the rest of the page
  // inert and the Escape key mean what it means everywhere else.
  useEffect(() => {
    box.current?.showModal()
  }, [])

  const taking = useMutation({
    mutationFn: async () => {
      const { response } = await api.DELETE('/spaces/{slug}/members/{userId}', {
        params: { path: { slug, userId: member.userId } },
      })
      if (!response.ok) throw new Error(String(response.status))
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['members', slug] })
      close()
    },
  })

  const working = held.data?.working ?? []
  const machines = held.data?.machines ?? []
  const said = words(member)

  return (
    <dialog className="checklist" ref={box} aria-labelledby={heading} onClose={close}>
      <h2 id={heading}>{said.title}</h2>

      <Reading held={held} theirs={said.theirs} empty={working.length + machines.length === 0} />

      <Running slug={slug} working={working} />
      <Machines machines={machines} />

      {/* Said out loud, because the alternative is somebody assuming this button tidies up. It
          does not, and finding that out afterwards is finding out that an agent has been running
          all night on a laptop nobody can reach. */}
      <p className="empty">
        Nothing here stops or moves. What is running keeps running until somebody stops it, and{' '}
        {said.their} machines stay where they are.
      </p>

      {taking.isError && <p className="empty">{whyNot(taking.error)}</p>}

      <div className="beside">
        <button className="button button-secondary" type="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button button-primary"
          type="button"
          disabled={taking.isPending}
          onClick={() => {
            taking.mutate()
          }}
        >
          {said.act}
        </button>
      </div>
    </dialog>
  )
}

/**
 * The same screen, said about yourself or about somebody else.
 *
 * Leaving and removing are one request aimed at two people, and the only difference a person
 * should ever see is the words. Computed in one place so the four of them cannot drift apart.
 */
function words(member: Member) {
  return member.you
    ? {
        // Not the slug: it is an address, not a name, and `Leave acme` is the screen showing its
        // own plumbing. Not the display name either — this dialog does not have it, and asking
        // for it to write one sentence is a second read of a fact the frame already holds.
        title: 'Leave this Space',
        theirs: 'yours',
        their: 'your',
        act: 'Leave this Space',
      }
    : {
        title: `Remove ${member.displayName}`,
        theirs: `${member.displayName}’s`,
        their: 'their',
        act: `Remove ${member.displayName}`,
      }
}

/** Refused for the one reason worth its own sentence, and otherwise plainly. */
function whyNot(trouble: Error): string {
  return trouble.message === '409'
    ? 'You are the only owner here. Make somebody else an owner first.'
    : 'That did not happen. Try again.'
}

/**
 * The three answers a read can give, kept apart.
 *
 * A read that failed is not "nothing is theirs" — and folding the two together would hand
 * somebody an empty checklist and let them press Remove believing it.
 */
function Reading({
  held,
  theirs,
  empty,
}: {
  readonly held: { isError: boolean; isPending: boolean; isSuccess: boolean }
  readonly theirs: string
  readonly empty: boolean
}) {
  if (held.isError)
    return <p className="empty">Could not read what is still {theirs}. Try again.</p>
  if (held.isPending) return <p className="empty">Looking…</p>
  if (held.isSuccess && empty) return <p className="empty">Nothing here is {theirs}.</p>

  return null
}

/** What is running under their name, each a way in rather than a decision made from here. */
function Running({
  slug,
  working,
}: {
  readonly slug: string
  readonly working: readonly {
    conversationId: string
    goal: string
    state: string
    machineName: string
  }[]
}) {
  if (working.length === 0) return null

  return (
    <>
      <h3>Still running</h3>
      <ul className="rows">
        {working.map((one) => (
          <li key={one.conversationId} className="row">
            <span className="row-name">
              <strong>{one.goal}</strong>
              <span className="note">
                {one.state} · {one.machineName}
              </span>
            </span>
            {/* A way in, not a way to decide from here. Whether this one should be stopped is
                answered by reading it, and reading it is one click away. */}
            <Link
              className="button-quiet"
              to="/s/$slug/c/$id"
              params={{ slug, id: one.conversationId }}
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Their machines, and whether anybody here is in the middle of using one. */
function Machines({
  machines,
}: {
  readonly machines: readonly { id: string; name: string; inUse: number }[]
}) {
  if (machines.length === 0) return null

  return (
    <>
      <h3>Machines</h3>
      <ul className="rows">
        {machines.map((one) => (
          <li key={one.id} className="row">
            <span className="row-name">
              <strong>{one.name}</strong>
              <span className="note">
                {one.inUse === 0 ? 'nobody is using it' : `${String(one.inUse)} running on it`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
