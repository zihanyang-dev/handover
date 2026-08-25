/**
 * Choosing a way in.
 *
 * The sentence about one address meaning one account sits above the choice, not below it. It is
 * what decides whether somebody dares click a different button than they did last time, and
 * saying it after they have chosen is the same as not saying it.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState, type ReactElement } from 'react'
import { ExclamationCircleFill, Github } from 'react-bootstrap-icons'
import { api, retryKey } from '../../api.ts'
import { Mark } from '../../mark.tsx'

/**
 * Google's mark in its own colors. The icon set's `Google` is the same glyph drawn in one ink,
 * and on this screen the four colors are how the button is recognised before it is read.
 */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.58 2.68-3.9 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  )
}

/**
 * Required, one entry per provider: a name added without a label and a mark is a compile error,
 * not a button that reads `undefined`.
 */
type Provider = 'google' | 'github'

const LOOKS: Record<Provider, { readonly label: string; readonly icon: ReactElement }> = {
  google: { label: 'Google', icon: <GoogleG /> },
  github: { label: 'GitHub', icon: <Github aria-hidden /> },
}

function known(kind: string): kind is Provider {
  return kind in LOOKS
}

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
function OtherWays({ next }: { readonly next: string | undefined }) {
  const offered = useQuery({ queryKey: ['credentials'], queryFn: offeredKinds })
  const providers = (offered.data ?? []).filter(isProvider)

  const leaveFor = useMutation({
    mutationFn: async (provider: string) => {
      const { data } = await api.POST('/auth/{provider}/start', {
        params: { path: { provider } },
        // The server puts it through `returnPath` again on the way back. Both sides check it,
        // because by then it has been through a site neither of them controls.
        body: { next: next ?? '/' },
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

export function SignIn({
  email: initial = '',
  next,
}: {
  readonly email?: string | undefined
  /** Where this person was going before they were asked to sign in. */
  readonly next?: string | undefined
}) {
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
    onSuccess: async (opened) =>
      navigate({
        to: '/sign-in/code',
        search: { ...opened, email, ...(next === undefined ? {} : { next }) },
      }),
  })

  return (
    <main className="auth">
      <span className="auth-mark">Handover</span>
      <form
        className="auth-stack"
        onSubmit={(event) => {
          event.preventDefault()
          askForCode.mutate(email)
        }}
      >
        <div className="auth-head">
          <Mark size={80} state={askForCode.isPending ? 'working' : 'idle'} />
          <h1>Sign in or sign up</h1>
          <p className="lede">However you sign in, the same address reaches the same account.</p>
        </div>

        {askForCode.isError && (
          <p className="said said-bad" role="alert">
            <ExclamationCircleFill aria-hidden />
            {SAID[askForCode.error.message] ?? 'That could not be sent. Try again shortly.'}
          </p>
        )}

        <OtherWays next={next} />

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
