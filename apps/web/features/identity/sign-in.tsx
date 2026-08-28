/**
 * Choosing a way in.
 *
 * The brand names the place and the provider and email controls make the task obvious. The form
 * keeps an accessible name without repeating a visible “Sign in” heading.
 */

import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { api, cached, reasonOf, retryKey } from '../../api.ts'
import { FieldError } from '../../components/ui/field-error.tsx'
import { GradientBlur } from '../../components/ui/gradient-blur.tsx'
import { HandwritingSvg } from '../../components/ui/handwriting-svg.tsx'
import { Mark } from '../../mark.tsx'
import { HANDOVER_WORDMARK } from './handover-wordmark.ts'
import { isProvider, PROVIDERS } from './providers.tsx'

const SAID: Record<string, string> = {
  'too-soon': 'A code just went out. Give it a moment.',
  'malformed-request': 'Check that address.',
  'address-refused': 'No mail can reach that address. Check it, or use a different one.',
}

/** Only what this deployment can actually offer: a door that opens onto an error is not a door. */
function OtherWays() {
  const offered = cached.useQuery('get', '/auth/credentials')
  const providers = (offered.data?.offered ?? []).filter(isProvider)

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
            {PROVIDERS[provider].icon}
            <span className="button-label">Continue with {PROVIDERS[provider].label}</span>
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
  const error = `${field}-error`

  const askForCode = useMutation({
    mutationFn: async (address: string) => {
      const { data, error } = await api.POST('/auth/email-codes', {
        body: { email: address, requestKey: retryKey(`code:${address}`) },
      })
      if (data === undefined) throw error
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
            {/* Before the buttons, not after them. `prd.md` 01 ①: whether somebody dares click a
                different one than last time is decided by reading this — said afterwards it is
                the same as not saying it. */}
            <p className="lede">The same address reaches the same account, whichever way in.</p>
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
              aria-describedby={error}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                // The red lifts as they retype; it described what they sent, not what is there.
                setRefused(false)
                askForCode.reset()
              }}
            />
            <FieldError id={error} shown={invalid}>
              {refused || askForCode.error === null
                ? SAID['malformed-request']
                : (SAID[reasonOf(askForCode.error) ?? ''] ??
                  'That could not be sent. Try again shortly.')}
            </FieldError>

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
