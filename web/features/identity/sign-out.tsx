/** Leaving. The session is revoked on the server, so the cookie alone cannot be put back. */

import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../../api.ts'

export function SignOut({ email }: { readonly email: string }) {
  const navigate = useNavigate()

  const leave = useMutation({
    mutationFn: async () => {
      await api.DELETE('/browser/sessions/current')
    },
    onSuccess: async () => navigate({ to: '/sign-in' }),
  })

  return (
    <div className="row">
      <span className="row-where">{email}</span>
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
