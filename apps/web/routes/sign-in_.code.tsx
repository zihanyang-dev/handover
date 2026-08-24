import { createFileRoute } from '@tanstack/react-router'
import { EmailedCode } from '../features/identity/emailed-code.tsx'

type Arrived = {
  email: string
  challengeId: string
  expiresAt: string
  resendAfterSeconds: number
}

/** All of it is required: without a challenge there is nothing here to hand anything back to. */
function arrived(search: Record<string, unknown>): Arrived {
  const { email, challengeId, expiresAt, resendAfterSeconds } = search
  if (
    typeof email !== 'string' ||
    typeof challengeId !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof resendAfterSeconds !== 'number'
  ) {
    throw new Error('this screen needs a challenge to hand a code back to')
  }
  return { email, challengeId, expiresAt, resendAfterSeconds }
}

function Screen() {
  return <EmailedCode {...Route.useSearch()} />
}

export const Route = createFileRoute('/sign-in_/code')({
  validateSearch: arrived,
  component: Screen,
})
