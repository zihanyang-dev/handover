import { createFileRoute } from '@tanstack/react-router'
import { EmailedCode } from '../features/identity/emailed-code.tsx'

type Arrived = {
  email: string
  challengeId: string
  expiresAt: string
  resendAfterSeconds: number
  digits: number
}

/** All of it is required: without a code sent, there is nothing here to answer. */
function arrived(search: Record<string, unknown>): Arrived {
  const { email, challengeId, expiresAt, resendAfterSeconds, digits } = search
  if (
    typeof email !== 'string' ||
    typeof challengeId !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof resendAfterSeconds !== 'number' ||
    typeof digits !== 'number'
  ) {
    throw new Error('this screen needs a code that was sent, to answer')
  }
  return { email, challengeId, expiresAt, resendAfterSeconds, digits }
}

function Screen() {
  return <EmailedCode {...Route.useSearch()} />
}

export const Route = createFileRoute('/sign-in_/code')({
  validateSearch: arrived,
  component: Screen,
})
