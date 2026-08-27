import { createFileRoute } from '@tanstack/react-router'
import { People } from '../features/spaces/people.tsx'

/** Who is in this Space, and — for an owner — how somebody else gets in or out. */
function Screen() {
  const { slug } = Route.useParams()

  return <People slug={slug} />
}

export const Route = createFileRoute('/s/$slug/people')({
  staticData: { where: 'People' },
  component: Screen,
})
