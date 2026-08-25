import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { api } from '../api.ts'
import { SignOut } from '../features/identity/sign-out.tsx'
import { Conversations } from '../features/conversations/conversations.tsx'
import { Machines } from '../features/machines/machines.tsx'

function Screen() {
  const { slug } = Route.useParams()
  const space = useQuery({
    queryKey: ['space', slug],
    queryFn: async () => {
      const { data } = await api.GET('/spaces/{slug}', { params: { path: { slug } } })
      return data ?? null
    },
  })

  // Nothing is known yet. Rendering the Space now would show its frame with no name in it, and
  // for a moment a Space that turns out not to exist looks like one that does.
  if (space.isPending) {
    return (
      <div className="page">
        <section className="panel">
          <p className="empty">Looking…</p>
        </section>
      </div>
    )
  }

  // A read that failed is not a Space that is missing. Saying "not available" here would send
  // somebody looking for a Space that is theirs and is there, over a moment of no network.
  if (space.isError) {
    return (
      <div className="page">
        <section className="panel">
          <p className="empty">Could not read this Space. Try again.</p>
        </section>
      </div>
    )
  }

  // Not there and not yours are the same answer, so this page cannot tell them apart either.
  if (space.data === null) {
    return (
      <div className="page">
        <section className="panel">
          <h2>This Space is not available</h2>
          <p className="note" style={{ marginTop: '0.5rem' }}>
            <Link to="/">Back to your Spaces</Link>
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="row">
        <span className="row-name">
          <strong>{space.data.displayName}</strong>
        </span>
        <Link className="row-where" to="/">
          All Spaces
        </Link>
      </div>
      <Machines slug={slug} />
      <Conversations slug={slug} />
      {/* Reachable from in here, not only from the Spaces list: somebody who came straight to a
          Space by its address should not have to go somewhere else to leave. */}
      <SignOut />
    </div>
  )
}

export const Route = createFileRoute('/s/$slug')({
  // Without this, nobody signed in reads as a Space that is not there — and somebody whose session
  // ran out is told their Space is gone rather than being asked to sign in again.
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
