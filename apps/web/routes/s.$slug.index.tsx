import { createFileRoute } from '@tanstack/react-router'
import { Machines } from '../features/machines/machines.tsx'

/** What a Space opens on: the machines anything here could run on. */
function Screen() {
  const { slug } = Route.useParams()

  return <Machines slug={slug} />
}

export const Route = createFileRoute('/s/$slug/')({
  staticData: { where: 'Home' },
  component: Screen,
})
