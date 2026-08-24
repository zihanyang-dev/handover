import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../api.ts'
import { Connect } from '../features/machines/connect.tsx'

/**
 * The way in that is typed.
 *
 * No code in the address here on purpose: a mistyped one has to land somewhere that can say the
 * code is not right, and a wrong address can only fail to be a page. The clickable form is
 * `/connect/{code}`, which is the same screen reached the other way.
 */
function Screen() {
  return <Connect typed="" />
}

export const Route = createFileRoute('/connect')({
  beforeLoad: async () => {
    const { response } = await api.GET('/me')
    if (response.status === 401) throw redirect({ to: '/sign-in' })
  },
  component: Screen,
})
