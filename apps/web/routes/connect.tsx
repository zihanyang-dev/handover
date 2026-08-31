import { createFileRoute } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Connect, connectSearch } from '../features/machines/connect.tsx'

/**
 * The way in that is typed.
 *
 * No code in the address here on purpose: a mistyped one has to land somewhere that can say the
 * code is not right, and a wrong address can only fail to be a page. The clickable form is
 * `/connect/{code}`, which is the same screen reached the other way.
 */
function Screen() {
  return <Connect typed="" spaceSlug={Route.useSearch().space} />
}

export const Route = createFileRoute('/connect')({
  validateSearch: connectSearch,
  beforeLoad: async ({ context, location }) => onlySignedIn(context.queryClient, location),
  component: Screen,
})
