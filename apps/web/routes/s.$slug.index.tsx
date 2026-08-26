import { createFileRoute } from '@tanstack/react-router'
import { Inbox } from '../features/conversations/inbox.tsx'
import { Machines } from '../features/machines/machines.tsx'

/** What a Space opens on: what is asking for you, then what you could go and do. */
function Screen() {
  const { slug } = Route.useParams()

  return (
    <>
      {/* Before the machines, because everything else here is somewhere to go and this is
          somebody waiting on an answer. */}
      <Inbox />
      <Machines slug={slug} />
    </>
  )
}

export const Route = createFileRoute('/s/$slug/')({
  staticData: { where: 'Home' },
  component: Screen,
})
