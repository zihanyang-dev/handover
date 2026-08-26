import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { api } from '../api.ts'
import { Conversation } from '../features/conversations/conversation.tsx'
import { Conversations } from '../features/conversations/conversations.tsx'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Home } from '../features/spaces/home.tsx'

function Screen() {
  const { slug, id } = Route.useParams()
  const space = useQuery({
    queryKey: ['space', slug],
    queryFn: async () => {
      const { data } = await api.GET('/spaces/{slug}', { params: { path: { slug } } })
      return data ?? null
    },
  })

  // Not there and not yours are the same answer, so this page cannot tell them apart either.
  // Said rather than left blank: a screen that renders nothing is one nobody can act on.
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

  if (space.data === undefined) return null

  return (
    <Home space={space.data} where="Conversation" aside={<Conversations slug={slug} />}>
      <Conversation slug={slug} id={id} />
    </Home>
  )
}

export const Route = createFileRoute('/s/$slug_/c/$id')({
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
