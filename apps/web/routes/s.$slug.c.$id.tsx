import { createFileRoute } from '@tanstack/react-router'
import { Chat } from '../features/conversations/chat.tsx'

function Screen() {
  const { slug, id } = Route.useParams()
  return <Chat slug={slug} id={id} />
}

export const Route = createFileRoute('/s/$slug/c/$id')({
  staticData: { where: 'Chat' },
  component: Screen,
})
