import { createFileRoute, Link } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Conversation } from '../features/conversations/conversation.tsx'

function Screen() {
  const { slug, id } = Route.useParams()

  return (
    <div className="page">
      <div className="row">
        <Link className="row-where" to="/s/$slug" params={{ slug }}>
          Back to the Space
        </Link>
      </div>
      <Conversation slug={slug} id={id} />
    </div>
  )
}

export const Route = createFileRoute('/s/$slug_/c/$id')({
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
