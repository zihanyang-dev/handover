import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Home } from '../features/spaces/home.tsx'
import { spaceQuery } from '../features/spaces/space.ts'

/**
 * The frame every screen inside a Space is shown in, and the one place it is mounted.
 *
 * A layout rather than something each screen renders: mounted twice, opening a conversation
 * unmounts the frame and puts it back, and the sidebar somebody had collapsed or dragged to a
 * width they liked is new again. Whatever is inside comes through the `Outlet`.
 */
function Screen() {
  const { slug } = Route.useParams()
  const space = useQuery(spaceQuery(slug))

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
          <p className="empty" role="alert">
            Try again in a moment.
          </p>
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
    <Home space={space.data}>
      <Outlet />
    </Home>
  )
}

export const Route = createFileRoute('/s/$slug')({
  beforeLoad: async ({ context, location }) => onlySignedIn(context.queryClient, location),
  component: Screen,
})
