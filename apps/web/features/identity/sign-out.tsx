/**
 * Leaving. The session is revoked on the server, so the cookie alone cannot be put back.
 *
 * It reads which account it is leaving rather than being told, so every screen that has to offer
 * a way out can offer it without first knowing who is signed in. `prd.md` wants this reachable
 * from inside a Space too, and a prop would have made that screen fetch `/me` for one string.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../../api.ts'
import { meQuery } from './me.ts'

export function SignOut() {
  const navigate = useNavigate()
  const me = useQuery(meQuery)
  const account = me.data?.credentials.find((one) => one.kind === 'email')?.address ?? ''

  const leave = useMutation({
    mutationFn: async () => {
      await api.DELETE('/browser/sessions/current')
    },
    onSuccess: async () => navigate({ to: '/sign-in' }),
  })

  return (
    <div className="row">
      <span className="row-where">{account}</span>
      <button
        className="button button-quiet"
        type="button"
        onClick={() => {
          leave.mutate()
        }}
      >
        <span className="button-label">Sign out</span>
      </button>
    </div>
  )
}
