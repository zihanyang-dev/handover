import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '../features/identity/sign-in.tsx'

/**
 * Coming back from the code screen brings the address along, so nobody retypes it; being sent here
 * from a screen behind a session brings the address of that screen, so signing in ends where the
 * person was going rather than at the front door.
 *
 * The return type is the type — there is no schema beside it to drift from. A URL is somebody
 * else's to write, so what comes out of here is only ever what was recognised.
 */
function asked(search: Record<string, unknown>): { email?: string; next?: string } {
  const email = search['email']
  const next = search['next']

  return {
    ...(typeof email === 'string' ? { email } : {}),
    ...(typeof next === 'string' ? { next } : {}),
  }
}

function Screen() {
  const { email, next } = Route.useSearch()

  return <SignIn email={email} next={next} />
}

export const Route = createFileRoute('/sign-in')({ validateSearch: asked, component: Screen })
