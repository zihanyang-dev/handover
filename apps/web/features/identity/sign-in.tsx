/**
 * Choosing a way in.
 *
 * The sentence about one address meaning one account sits above the choice, not below it. It is
 * what decides whether somebody dares click a different button than they did last time, and
 * saying it after they have chosen is the same as not saying it.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { ExclamationCircleFill } from 'react-bootstrap-icons'
import { api, retryKey } from '../../api.ts'
import { isProvider, PROVIDERS } from './providers.tsx'

const SAID: Record<string, string> = {
  'too-soon': 'A code just went out. Give it a moment.',
  'malformed-request': 'Check that address.',
  'address-refused': 'No mail can reach that address. Check it, or use a different one.',
}

async function offeredKinds(): Promise<readonly string[]> {
  const { data } = await api.GET('/auth/credentials')
  return data?.offered ?? []
}

/** Only what this deployment can actually offer: a door that opens onto an error is not a door. */
function OtherWays() {
  const offered = useQuery({ queryKey: ['credentials'], queryFn: offeredKinds })
  const providers = (offered.data ?? []).filter(isProvider)

  const leaveFor = useMutation({
    mutationFn: async (provider: string) => {
      const { data } = await api.POST('/auth/{provider}/start', {
        params: { path: { provider } },
        body: { next: '/' },
      })
      // The browser goes; a page cannot read where a redirect points.
      if (data !== undefined) globalThis.location.href = data.url
    },
  })

  if (providers.length === 0) return null

  return (
    <>
      {providers.map((provider) => (
        <button
          key={provider}
          className="button button-secondary"
          type="button"
          onClick={() => {
            leaveFor.mutate(provider)
          }}
        >
          {PROVIDERS[provider].icon}
          <span className="button-label">Continue with {PROVIDERS[provider].label}</span>
        </button>
      ))}
      <div className="or">or</div>
    </>
  )
}

export function SignIn({ email: initial = '' }: { readonly email?: string | undefined }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState(initial)
  const field = useId()

  const askForCode = useMutation({
    mutationFn: async (address: string) => {
      const { data, error } = await api.POST('/auth/email-codes', {
        body: { email: address, requestKey: retryKey(`code:${address}`) },
      })
      if (data === undefined) throw new Error(error.reason)
      return data
    },
    onSuccess: async (opened) => navigate({ to: '/sign-in/code', search: { ...opened, email } }),
  })

  return (
    <main className="sheet">
      <form
        className="card stack"
        onSubmit={(event) => {
          event.preventDefault()
          askForCode.mutate(email)
        }}
      >
        <div className="stack-tight">
          <h1>Sign in or sign up</h1>
          <p className="lede">However you sign in, the same address reaches the same account.</p>
        </div>

        {askForCode.isError && (
          <p className="said said-bad" role="alert">
            <ExclamationCircleFill aria-hidden />
            {SAID[askForCode.error.message] ?? 'That could not be sent. Try again shortly.'}
          </p>
        )}

        <OtherWays />

        <div className="stack-tight">
          <label className="label" htmlFor={field}>
            Email address
          </label>
          <input
            id={field}
            className="field"
            type="email"
            name="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
          />
        </div>

        <button className="button button-primary" type="submit" disabled={askForCode.isPending}>
          <span className="button-label">{askForCode.isPending ? 'Sending…' : 'Send a code'}</span>
        </button>
      </form>
    </main>
  )
}
