import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { api } from '../api.ts'
import { Conversations } from '../features/conversations/conversations.tsx'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Home } from '../features/spaces/home.tsx'

/**
 * The frame every screen inside a Space is shown in, and the one place it is mounted.
 *
 * A layout rather than something each screen renders: mounted twice, opening a conversation
 * unmounts the frame and puts it back, and the sidebar somebody had collapsed or dragged to a
 * width they liked is new again. Whatever is inside comes through the `Outlet`.
 */
function Screen() {
  const { slug } = Route.useParams()
  const space = useQuery({
    queryKey: ['space', slug],
    queryFn: async () => {
      // A 404 is "not there, or not yours" — one answer on purpose, so an address cannot be used
      // to find out which Spaces exist. Anything else is a read that failed, and saying "not
      // available" to that sends somebody looking for a Space that is theirs and is there.
      const { data, error, response } = await api.GET('/spaces/{slug}', {
        params: { path: { slug } },
      })
      if (response.status === 404) return null
      if (data === undefined) throw new Error(error.reason)

      return data
    },
  })

  // Nothing is known yet. Rendering the frame now would show it with no name in it, and for a
  // moment a Space that turns out not to exist looks like one that does.
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
      <main className="home-state">
        <div>
          <h1>Could not read this Space</h1>
          <p className="empty">Try again in a moment.</p>
        </div>
      </main>
    )
  }

  if (space.data === null) {
    return (
      <main className="home-state">
        <div>
          <h1>This Space is not available</h1>
          <Link to="/onboarding">Back to your Spaces</Link>
        </div>
      </main>
    )
  }

  return (
    <Home space={space.data} aside={<Conversations slug={slug} />}>
      <Outlet />
    </Home>
  )
}

export const Route = createFileRoute('/s/$slug')({
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
