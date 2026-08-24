import { createFileRoute, redirect } from '@tanstack/react-router'
import { CheckCircleFill, ExclamationCircleFill } from 'react-bootstrap-icons'
import { api } from '../api.ts'
import { DisplayName } from '../features/identity/display-name.tsx'
import { Credentials } from '../features/identity/credentials.tsx'
import { NewSpace } from '../features/spaces/new-space.tsx'
import { SpaceList } from '../features/spaces/space-list.tsx'
import { SignOut } from '../features/identity/sign-out.tsx'

/** What a trip through a provider left behind, if it left anything. */
function arrived(search: Record<string, unknown>): { handover_result?: string } {
  const result = search['handover_result']
  return typeof result === 'string' ? { handover_result: result } : {}
}

/**
 * Every way a trip can end badly, in words about what to do next.
 *
 * A trip that failed and said nothing looks exactly like a button that does nothing. Every one of
 * these was silent once, and the silence was indistinguishable from the feature being broken.
 */
const WENT_WRONG: Record<string, string> = {
  cancelled: 'Nothing was connected, and nothing changed.',
  expired: 'That took too long. Try connecting it again.',
  'no-verified-email': 'That account has no confirmed address, so it cannot be used here.',
  'linked-elsewhere': 'That account is already connected to a different Handover account.',
  'already-connected': 'You already have one of those connected.',
}

function Screen() {
  const { handover_result: result } = Route.useSearch()
  const wentWrong = result === undefined ? undefined : WENT_WRONG[result]

  return (
    <div className="page">
      {/*
        Said once, on the answer that caused it. The key goes on exactly once, so the response
        that put it there is the one time to mention it — nothing has to remember having said it,
        and a reload does not say it again.
      */}
      {result === 'merged' && (
        <p className="said said-good">
          <CheckCircleFill aria-hidden />
          You already had an account here. This way of signing in now reaches the same one.
        </p>
      )}

      {wentWrong !== undefined && (
        <p className="said said-bad">
          <ExclamationCircleFill aria-hidden />
          {wentWrong}
        </p>
      )}

      <SpaceList />
      <NewSpace />
      <Credentials />
      <DisplayName />
      <SignOut />
    </div>
  )
}

export const Route = createFileRoute('/')({
  validateSearch: arrived,
  beforeLoad: async ({ context }) => {
    const { response } = await api.GET('/me')
    if (response.status === 401) throw redirect({ to: '/sign-in' })
    return context
  },
  component: Screen,
})
