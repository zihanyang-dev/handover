/**
 * Handing the code back.
 *
 * How long the code lasts and how long until another may be asked for both arrive with the
 * challenge. A number compiled into this page would be right until somebody changed the server
 * and not this, and nothing would say which of the two was lying.
 */

import { useMutation } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ExclamationCircleFill } from 'react-bootstrap-icons'
import { api, retryKey, retryKeyDone } from '../../api.ts'

const DIGITS = 6

/** Rounded up, so "1 minute" never means "any moment now". */
function minutesLeft(expiresAt: string): number {
  return Math.max(Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000), 0)
}

/**
 * What the `identity` owner decided, said to the person it happened to. Five answers, because
 * five different things to do next — and `consumed` never merges with `code-mismatch`, because
 * only one of them means somebody else may have used the code.
 */
const SAID: Record<string, string> = {
  'code-mismatch': 'That code is not right. Check the newest email.',
  expired: 'That code has expired. Ask for another.',
  consumed:
    'That code has already been used. If that was not you, ask for another and keep an eye on this inbox.',
  'attempts-exhausted': 'Too many tries. This code is finished — start again from your inbox.',
  'no-challenge': 'That sign-in is no longer here. Start again.',
  'malformed-request': 'The code is six digits.',
  'address-refused': 'No mail can reach that address. Use a different one.',
  'too-soon': 'A code just went out. Give it a moment.',
}

function useCountdown(seconds: number): number {
  const [left, setLeft] = useState(seconds)

  useEffect(() => {
    if (left <= 0) return undefined
    const timer = setTimeout(() => {
      setLeft(left - 1)
    }, 1000)
    return () => {
      clearTimeout(timer)
    }
  }, [left])

  return left
}

/** Asking again is a new request, so the key that stood for the last one is spent first. */
function Resend({ email, after }: { readonly email: string; readonly after: number }) {
  const navigate = useNavigate()
  const waiting = useCountdown(after)

  const resend = useMutation({
    mutationFn: async () => {
      retryKeyDone(`code:${email}`)
      const { data, error } = await api.POST('/auth/email/challenges', {
        body: { email, requestKey: retryKey(`code:${email}`) },
      })
      if (data === undefined) throw new Error(error.reason)
      return data
    },
    onSuccess: async (opened) => navigate({ to: '/sign-in/code', search: { email, ...opened } }),
  })

  return (
    <div className="card stack-tight" style={{ marginTop: '0.75rem' }}>
      {/* A button that did nothing looks the same as a letter that never came. */}
      {resend.isError && (
        <p className="said said-bad">
          <ExclamationCircleFill aria-hidden />
          {SAID[resend.error.message] ?? 'That could not be sent. Try again shortly.'}
        </p>
      )}
      <button
        className="button button-secondary"
        type="button"
        disabled={waiting > 0 || resend.isPending}
        onClick={() => {
          resend.mutate()
        }}
      >
        <span className="button-label">
          {waiting > 0 ? `Send another in ${String(waiting)}s` : 'Send another'}
        </span>
      </button>
      {/* Going back carries the address, so nobody retypes what they just typed. */}
      <Link className="note" to="/sign-in" search={{ email }}>
        Use a different address
      </Link>
    </div>
  )
}

export function EmailedCode({
  email,
  challengeId,
  expiresAt,
  resendAfterSeconds,
}: {
  readonly email: string
  readonly challengeId: string
  readonly expiresAt: string
  readonly resendAfterSeconds: number
}) {
  const navigate = useNavigate()
  const [code, setCode] = useState('')

  const handBack = useMutation({
    mutationFn: async (digits: string) => {
      const { data, error } = await api.POST('/auth/email/challenges/{id}/verify', {
        params: { path: { id: challengeId } },
        body: { code: digits },
      })
      if (data === undefined) throw new Error(error.reason)
      retryKeyDone(`code:${email}`)
      return data
    },
    onSuccess: async () => navigate({ to: '/' }),
  })

  return (
    <main className="sheet">
      <form
        className="card stack"
        onSubmit={(event) => {
          event.preventDefault()
          handBack.mutate(code)
        }}
      >
        <div className="stack-tight">
          <h1>Check your email</h1>
          <p className="lede">
            We sent a six-digit code to <span className="address">{email}</span>. It works for{' '}
            {minutesLeft(expiresAt)} minutes, and only the newest one works.
          </p>
        </div>

        {handBack.isError && (
          <p className="said said-bad">
            <ExclamationCircleFill aria-hidden />
            {SAID[handBack.error.message] ?? 'That could not be checked. Try again shortly.'}
          </p>
        )}

        <input
          className="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={DIGITS}
          autoFocus
          aria-label="Six-digit code"
          value={code}
          onChange={(event) => {
            const digits = event.target.value.replaceAll(/\D/gu, '').slice(0, DIGITS)
            setCode(digits)
            // Six digits and nothing left to decide, so there is nothing to press. The digits go
            // straight in: submitting the form here would read a `code` this keystroke has not
            // reached yet, and hand back five.
            if (digits.length === DIGITS) handBack.mutate(digits)
          }}
        />

        <button className="button button-primary" type="submit" disabled={handBack.isPending}>
          <span className="button-label">{handBack.isPending ? 'Signing in…' : 'Continue'}</span>
        </button>
      </form>

      <Resend email={email} after={resendAfterSeconds} />
    </main>
  )
}
