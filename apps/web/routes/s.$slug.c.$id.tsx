import { createFileRoute } from '@tanstack/react-router'
import { Conversation } from '../features/conversations/conversation.tsx'

/** One conversation, inside the Space frame its route already put around it. */
function Screen() {
  const { slug, id } = Route.useParams()

  return <Conversation slug={slug} id={id} />
}

export const Route = createFileRoute('/s/$slug/c/$id')({
  staticData: { where: 'Conversation' },
  component: Screen,
})
