/**
 * Leaving. The session is revoked on the server, so the cookie alone cannot be put back.
 *
 * It reads which account it is leaving rather than being told, so every screen that has to offer
 * a way out can offer it without first knowing who is signed in. `prd.md` wants this reachable
 * from inside a Space too, and a prop would have made that screen fetch `/me` for one string.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../../api.ts'
import { meQuery } from './me.ts'

export function SignOut() {
  const navigate = useNavigate()
  const me = useQuery(meQuery)
  const account = me.data?.credentials.find((one) => one.kind === 'email')?.address ?? ''

  const client = useQueryClient()

  const leave = useMutation({
    mutationFn: async () => {
      const { response } = await api.DELETE('/browser/sessions/current')
      // Not left. Navigating anyway would show the sign-in page to somebody still signed in, and
      // the next screen they open would be their account again.
      if (!response.ok) throw new Error('still-here')
    },
    onSuccess: async () => {
      // Everything that was true because of who was signed in. Kept, the next account to sign in
      // on this tab sees the last one's name, Spaces and ways in until each query refetches.
      client.clear()
      await navigate({ to: '/sign-in' })
    },
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
        <span className="button-label">{leave.isError ? 'Could not sign out' : 'Sign out'}</span>
      </button>
    </div>
  )
}
