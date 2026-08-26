/**
 * Choosing a way in.
 *
 * The brand names the place and the provider and email controls make the task obvious. The form
 * keeps an accessible name without repeating a visible “Sign in” heading.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState, type ReactElement } from 'react'
import { api, retryKey } from '../../api.ts'
import { GradientBlur } from '../../components/ui/gradient-blur.tsx'
import { HandwritingSvg } from '../../components/ui/handwriting-svg.tsx'
import { Mark } from '../../mark.tsx'
import { HANDOVER_WORDMARK } from './handover-wordmark.ts'
import { GitHubMark, GoogleMark } from './provider-marks.tsx'

/**
 * Required, one entry per provider: a name added without a label and a mark is a compile error,
 * not a button that reads `undefined`.
 */
type Provider = 'google' | 'github'

const LOOKS: Record<Provider, { readonly label: string; readonly icon: ReactElement }> = {
  google: { label: 'Google', icon: <GoogleMark /> },
  github: { label: 'GitHub', icon: <GitHubMark /> },
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
function OtherWays() {
  const offered = useQuery({ queryKey: ['credentials'], queryFn: offeredKinds })
  const providers = (offered.data ?? []).filter(isProvider)

  const leaveFor = useMutation({
    mutationFn: async (provider: string) => {
      const { data } = await api.POST('/auth/{provider}/start', {
        params: { path: { provider } },
        body: { next: '/onboarding' },
      })
      // The browser goes; a page cannot read where a redirect points.
      if (data !== undefined) globalThis.location.href = data.url
    },
  })

  if (providers.length === 0) return null

  return (
    <>
      <div className="auth-ways">
        {providers.map((provider) => (
          <button
            key={provider}
            className="button button-secondary"
            type="button"
            onClick={() => {
              leaveFor.mutate(provider)
            }}
          >
            {LOOKS[provider].icon}
            <span className="button-label">Continue with {LOOKS[provider].label}</span>
          </button>
        ))}
      </div>
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
  /** A format the form itself can rule out; anything subtler is the server's to say. */
  const [refused, setRefused] = useState(false)
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

  const invalid = refused || askForCode.isError

  return (
    <GradientBlur>
      <main className="auth auth-on-gradient-blur">
        <form
          aria-label="Sign in"
          className="auth-stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const address = email.trim()
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
              setRefused(true)
              return
            }
            askForCode.mutate(address)
          }}
        >
          <div className="auth-head">
            <div className="auth-brand">
              <Mark size={54} state={askForCode.isPending ? 'working' : 'thinking'} />
              <HandwritingSvg
                path={HANDOVER_WORDMARK}
                width={217}
                height={50}
                strokeWidth={1.1}
                duration={2.2}
                delay={0.1}
                className="auth-wordmark"
              />
            </div>
          </div>

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
              aria-invalid={invalid}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                // The red lifts as they retype; it described what they sent, not what is there.
                setRefused(false)
                askForCode.reset()
              }}
            />
            <p className="auth-error" data-shown={invalid ? '' : undefined}>
              {invalid
                ? refused || askForCode.error === null
                  ? SAID['malformed-request']
                  : (SAID[askForCode.error.message] ?? 'That could not be sent. Try again shortly.')
                : null}
            </p>

            <button
              className="button button-primary"
              type="submit"
              disabled={email.trim() === '' || askForCode.isPending}
            >
              <span className="button-label">Continue</span>
            </button>
          </div>
        </form>
      </main>
    </GradientBlur>
  )
}
