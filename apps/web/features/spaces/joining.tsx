/**
 * Somebody who was sent a link.
 *
 * Not inside a Space's frame, because they are not in it yet — and the frame would be a sidebar
 * of a Space they cannot read. What this screen owes them is one sentence and one button.
 *
 * Signing in first is the route's job, not this screen's: a link followed by somebody signed out
 * goes to the front door carrying where it was going, and lands back here afterwards.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api, cached } from '../../api.ts'
import { ME } from '../identity/me.ts'

function whatItOpens(secret: string) {
  return {
    queryKey: cached.queryOptions('get', '/invitations/{secret}', {
      params: { path: { secret } },
    }).queryKey,
    // One try. A link that does not work does not start working, and asking four times is four
    // seconds of "Looking…" before the same answer.
    retry: false,
    queryFn: async () => {
      const { data, response, error } = await api.GET('/invitations/{secret}', {
        params: { path: { secret } },
      })
      // Revoked, run out, or never a link — one answer, because what to do about all three is the
      // same. Anything else is this page failing to read, and saying "that link is dead" to a
      // server that broke sends somebody back to ask for a link that was fine.
      if (response.status === 404) return null
      if (data === undefined) throw error

      return data
    },
  }
}

export function Joining({ secret }: { readonly secret: string }) {
  const opens = useQuery(whatItOpens(secret))
  const client = useQueryClient()
  const navigate = useNavigate()

  const joining = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/me/spaces', { body: { secret } })
      if (data === undefined) throw error

      return data.slug
    },
    onSuccess: async (slug) => {
      // The list of Spaces in the frame is now one longer, and it is read from `/me`.
      await client.invalidateQueries({ queryKey: ME })
      await navigate({ to: '/s/$slug', params: { slug } })
    },
  })

  if (opens.isPending) {
    return (
      <main className="sheet">
        <p className="empty" role="status">
          Looking…
        </p>
      </main>
    )
  }

  if (opens.isError) {
    return (
      <main className="sheet">
        <div className="card stack">
          <h1>Could not read this link</h1>
          <p className="empty" role="alert">
            Try again in a moment.
          </p>
        </div>
      </main>
    )
  }

  if (opens.data === null) {
    return (
      <main className="sheet">
        <div className="card stack">
          <h1>This link no longer works</h1>
          {/* Whoever sent it can send another. Saying so is the difference between a dead end and
              a thing to do next. */}
          <p className="empty">
            Links stop working after seven days, and whoever asked you can stop one at any time. Ask
            them for a new one.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="sheet">
      <div className="card stack">
        <h1>
          {opens.data.invitedBy} asked you to join {opens.data.displayName}
        </h1>
        <button
          className="button button-primary"
          type="button"
          disabled={joining.isPending}
          onClick={() => {
            joining.mutate()
          }}
        >
          Join {opens.data.displayName}
        </button>
        {joining.isError && (
          <p className="empty" role="alert">
            That did not work. Try again.
          </p>
        )}
      </div>
    </main>
  )
}
