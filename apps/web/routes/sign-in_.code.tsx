import { createFileRoute, redirect } from '@tanstack/react-router'
import { EmailCode } from '../features/identity/email-code.tsx'

type Arrived = {
  email: string
  codeId: string
  expiresAt: string
  resendAfterSeconds: number
  digits: number
  /** Where the person was going before they were asked to sign in. */
  next?: string
}

/**
 * What was recognised in the address, and nothing else.
 *
 * A URL is somebody else's to write, so this only ever hands on what it knows the shape of. What
 * it does not do is refuse: refusing here throws before the router can act on it, and the person
 * gets the router's own error page instead of a screen they can do something with.
 */
type Recognised = { readonly [K in keyof Arrived]?: Arrived[K] | undefined }

function recognised(search: Record<string, unknown>): Recognised {
  const said = (name: string) => (typeof search[name] === 'string' ? search[name] : undefined)
  const counted = (name: string) => (typeof search[name] === 'number' ? search[name] : undefined)

  return {
    email: said('email'),
    codeId: said('codeId'),
    expiresAt: said('expiresAt'),
    next: said('next'),
    resendAfterSeconds: counted('resendAfterSeconds'),
    digits: counted('digits'),
  }
}

/** Without a code that was really sent, there is nothing on this screen to answer. */
function isComplete(search: Recognised): search is Arrived {
  return (
    search.email !== undefined &&
    search.codeId !== undefined &&
    search.expiresAt !== undefined &&
    search.resendAfterSeconds !== undefined &&
    search.digits !== undefined
  )
}

function Screen() {
  const search = Route.useSearch()
  // Unreachable: `beforeLoad` sent an incomplete address away before this rendered. Said as a
  // narrowing rather than an assertion, because the one thing worse than an error page is a
  // screen that throws while somebody is looking at it.
  if (!isComplete(search)) return null

  return <EmailCode {...search} />
}

export const Route = createFileRoute('/sign-in_/code')({
  validateSearch: recognised,
  // Somewhere they can act, rather than the router's error page: whoever typed or shared this URL
  // wrong needs the screen that asks for an address, and it keeps the address if there was one.
  beforeLoad: ({ search }) => {
    if (!isComplete(search)) {
      throw redirect({
        to: '/sign-in',
        search: search.email === undefined ? {} : { email: search.email },
      })
    }
  },
  component: Screen,
})
