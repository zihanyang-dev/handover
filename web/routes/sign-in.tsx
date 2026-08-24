import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '../features/identity/sign-in.tsx'

/**
 * Coming back from the code screen brings the address along, so nobody retypes it.
 *
 * The return type is the type — there is no schema beside it to drift from. A URL is somebody
 * else's to write, so what comes out of here is only ever what was recognised.
 */
function asked(search: Record<string, unknown>): { email?: string } {
  const email = search['email']
  return typeof email === 'string' ? { email } : {}
}

function Screen() {
  return <SignIn email={Route.useSearch().email} />
}

export const Route = createFileRoute('/sign-in')({ validateSearch: asked, component: Screen })
