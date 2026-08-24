import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { CheckCircleFill } from 'react-bootstrap-icons'
import { api } from '../api.ts'
import { DisplayName } from '../features/identity/display-name.tsx'
import { meQuery } from '../features/identity/me.ts'
import { WaysIn } from '../features/identity/ways-in.tsx'
import { NewSpace } from '../features/spaces/new-space.tsx'
import { SpaceList } from '../features/spaces/space-list.tsx'
import { SignOut } from '../features/identity/sign-out.tsx'

/** What a trip through a provider left behind, if it left anything. */
function arrived(search: Record<string, unknown>): { handover_result?: string } {
  const result = search['handover_result']
  return typeof result === 'string' ? { handover_result: result } : {}
}

function Screen() {
  const me = useQuery(meQuery)
  const { handover_result: result } = Route.useSearch()

  return (
    <div className="page">
      {/*
        Said once, on the answer that caused it. The link is made exactly once per provider per
        account, so the response that made it is the one time to mention it — nothing has to
        remember having said it, and a reload does not say it again.
      */}
      {result === 'merged' && (
        <p className="said said-good">
          <CheckCircleFill aria-hidden />
          You already had an account here. This way of signing in now reaches the same one.
        </p>
      )}

      <SpaceList />
      <NewSpace />
      <WaysIn />
      <DisplayName />
      <SignOut email={me.data?.verifiedEmail ?? ''} />
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
