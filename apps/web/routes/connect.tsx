import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../api.ts'
import { Connect } from '../features/machines/connect.tsx'

/** The code may be in the address already, so somebody who could click did not have to type. */
function arrived(search: Record<string, unknown>): { code?: string } {
  const code = search['code']
  return typeof code === 'string' ? { code } : {}
}

function Screen() {
  return <Connect typed={Route.useSearch().code ?? ''} />
}

export const Route = createFileRoute('/connect')({
  validateSearch: arrived,
  beforeLoad: async () => {
    const { response } = await api.GET('/me')
    if (response.status === 401) throw redirect({ to: '/sign-in' })
  },
  component: Screen,
})
