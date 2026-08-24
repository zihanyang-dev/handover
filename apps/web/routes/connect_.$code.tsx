import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../api.ts'
import { Connect } from '../features/machines/connect.tsx'

/**
 * The same screen, reached by an address that already carries the code.
 *
 * The plain one stays the way in that is typed: a mistyped code has to land on a page that can
 * say "that code is not right", and a wrong address can only say nothing at all.
 */
function Screen() {
  return <Connect typed={Route.useParams().code} />
}

export const Route = createFileRoute('/connect_/$code')({
  beforeLoad: async () => {
    const { response } = await api.GET('/me')
    if (response.status === 401) throw redirect({ to: '/sign-in' })
  },
  component: Screen,
})
