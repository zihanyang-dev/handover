import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../api.ts'
import { ConnectHost } from '../features/onboarding/host.tsx'

/** The Space a machine is for, when the address says. With exactly one it need not. */
function asked(search: Record<string, unknown>): { s?: string } {
  const s = search['s']
  return typeof s === 'string' ? { s } : {}
}

function Screen() {
  return <ConnectHost forSlug={Route.useSearch().s} />
}

export const Route = createFileRoute('/onboarding_/host')({
  validateSearch: asked,
  beforeLoad: async () => {
    const { response } = await api.GET('/me')
    if (response.status === 401) throw redirect({ to: '/sign-in' })
  },
  component: Screen,
})
