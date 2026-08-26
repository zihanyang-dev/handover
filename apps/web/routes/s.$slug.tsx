import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { api } from '../api.ts'
import { Home } from '../features/spaces/home.tsx'

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
      <main className="home-state">
        <p>Looking…</p>
      </main>
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
  if (space.data === null || space.data === undefined) {
    return (
      <main className="home-state">
        <div>
          <h1>This Space is not available</h1>
          <Link to="/onboarding">Back to your Spaces</Link>
        </div>
      </main>
    )
  }

  return <Home space={space.data} />
}

export const Route = createFileRoute('/s/$slug')({
  // Without this, nobody signed in reads as a Space that is not there — and somebody whose session
  // ran out is told their Space is gone rather than being asked to sign in again.
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
