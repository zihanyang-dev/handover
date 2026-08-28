import { createFileRoute } from '@tanstack/react-router'
import { Joining } from '../features/spaces/joining.tsx'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'

/**
 * A link somebody was sent.
 *
 * Behind a session like every other screen, and for one extra reason: a link that answered to
 * nobody would tell whoever guessed an address whether a Space exists. `prd.md` 01 ⑥.
 */
function Screen() {
  const { secret } = Route.useParams()

  return <Joining secret={secret} />
}

export const Route = createFileRoute('/join/$secret')({
  beforeLoad: async ({ context, location }) => onlySignedIn(context.queryClient, location),
  component: Screen,
})
