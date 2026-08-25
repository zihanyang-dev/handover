import { createFileRoute, Link } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Conversation } from '../features/conversations/conversation.tsx'
import { SignOut } from '../features/identity/sign-out.tsx'

function Screen() {
  const { slug, id } = Route.useParams()

  return (
    <div className="page">
      {/* Which Space this is, and both ways out of it. A screen inside a Space that cannot say
          which one, or let somebody leave it, is one they have to use the browser's back button
          on — and `prd.md` asks for neither. */}
      <div className="row">
        <span className="row-name">
          <Link to="/s/$slug" params={{ slug }}>
            <strong>{slug}</strong>
          </Link>
        </span>
        <Link className="row-where" to="/">
          All Spaces
        </Link>
      </div>
      <Conversation slug={slug} id={id} />
      <SignOut />
    </div>
  )
}

export const Route = createFileRoute('/s/$slug_/c/$id')({
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
