import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { api } from '../api.ts'
import { SignOut } from '../features/identity/sign-out.tsx'
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
          <strong>{space.data?.displayName ?? ''}</strong>
        </span>
        <Link className="row-where" to="/">
          All Spaces
        </Link>
      </div>
      <Machines slug={slug} />
      {/* Reachable from in here, not only from the Spaces list: somebody who came straight to a
          Space by its address should not have to go somewhere else to leave. */}
      <SignOut />
    </div>
  )
}

export const Route = createFileRoute('/s/$slug')({ component: Screen })
