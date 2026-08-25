import { createFileRoute } from '@tanstack/react-router'
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

/** All of it is required: without a code sent, there is nothing here to answer. */
function arrived(search: Record<string, unknown>): Arrived {
  const { email, codeId, expiresAt, resendAfterSeconds, digits } = search
  if (
    typeof email !== 'string' ||
    typeof codeId !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof resendAfterSeconds !== 'number' ||
    typeof digits !== 'number'
  ) {
    throw new Error('this screen needs a code that was sent, to answer')
  }
  return {
    email,
    codeId,
    expiresAt,
    resendAfterSeconds,
    digits,
    ...(typeof search['next'] === 'string' ? { next: search['next'] } : {}),
  }
}

function Screen() {
  return <EmailCode {...Route.useSearch()} />
}

export const Route = createFileRoute('/sign-in_/code')({
  validateSearch: arrived,
  component: Screen,
})
