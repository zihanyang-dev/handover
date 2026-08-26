/**
 * Adding another address that opens this account.
 *
 * Two steps, the same two as signing in, because proving an address is the same act whoever is
 * asking. What differs is only what the proof is spent on, and that is the server's business.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { ExclamationCircleFill } from 'react-bootstrap-icons'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import { ME } from './me.ts'

const SAID: Record<string, string> = {
  'address-elsewhere': 'That address already opens a different account. Sign in with it instead.',
  'address-refused': 'No mail can reach that address. Check it, or use a different one.',
  'too-soon': 'A code just went out. Give it a moment.',
  'code-mismatch': 'That code is not right. Check the newest email.',
  expired: 'That code has expired. Ask for another.',
  consumed: 'That code has already been used. Ask for another.',
  'attempts-exhausted': 'Too many tries. Start again from the address.',
  'no-code': 'That has expired. Start again from the address.',
  'malformed-request': 'Check that address.',
}

function Said({ reason, fallback }: { readonly reason: string; readonly fallback: string }) {
  return (
    <p className="said said-bad" role="alert">
      <ExclamationCircleFill aria-hidden />
      {SAID[reason] ?? fallback}
    </p>
  )
}

/** What sending a code left behind: which address, which letter to answer, and how long it is. */
type Sent = { readonly address: string; readonly id: string; readonly digits: number }

function AskForAddress({ onSent }: { readonly onSent: (sent: Sent) => void }) {
  const field = useId()
  const [address, setAddress] = useState('')

  const send = useMutation({
    mutationFn: async (to: string): Promise<Sent> => {
      const { data, error } = await api.POST('/me/credentials/email-codes', {
        body: { email: to, requestKey: retryKey(`attach:${to}`) },
      })
      if (data === undefined) throw new Error(error.reason)
      return { address: to, id: data.codeId, digits: data.digits }
    },
    onSuccess: onSent,
  })

  return (
    <form
      className="stack-tight"
      style={{ marginTop: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault()
        send.mutate(address.trim())
      }}
    >
      {send.isError && (
        <Said reason={send.error.message} fallback="That could not be sent. Try again shortly." />
      )}

      <label className="label" htmlFor={field}>
        Add another address
      </label>
      <div className="beside">
        <input
          id={field}
          className="field"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value)
          }}
        />
        <button
          className="button button-secondary"
          type="submit"
          disabled={address.trim() === '' || send.isPending}
        >
          <span className="button-label">{send.isPending ? 'Sending…' : 'Send a code'}</span>
        </button>
      </div>
    </form>
  )
}

function AnswerCode({ sent, onDone }: { readonly sent: Sent; readonly onDone: () => void }) {
  const client = useQueryClient()
  const field = useId()
  const [code, setCode] = useState('')

  const answer = useMutation({
    mutationFn: async (digits: string) => {
      const { error, response } = await api.POST('/me/credentials', {
        body: { codeId: sent.id, code: digits },
      })
      if (!response.ok) throw new Error(error?.reason ?? 'unavailable')
      retryKeyDone(`attach:${sent.address}`)
    },
    onSuccess: async () => {
      onDone()
      await client.invalidateQueries({ queryKey: ME })
    },
  })

  return (
    <form
      className="stack-tight"
      style={{ marginTop: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault()
        // Enter, with the code half typed. All of them go by themselves, so this can only ever be
        // an incomplete one — and sending it spends an attempt on a code nobody finished.
        if (code.length === sent.digits) answer.mutate(code)
      }}
    >
      {answer.isError && (
        <Said reason={answer.error.message} fallback="That could not be checked. Try again." />
      )}

      <label className="label" htmlFor={field}>
        Code sent to {sent.address}
      </label>
      <div className="beside">
        <input
          id={field}
          className="field"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={sent.digits}
          autoFocus
          value={code}
          onChange={(event) => {
            const digits = event.target.value.replaceAll(/\D/gu, '').slice(0, sent.digits)
            setCode(digits)
            // All of them and nothing left to decide. The digits go straight in: submitting the
            // form would read a `code` this keystroke has not reached yet, and hand back one short.
            if (digits.length === sent.digits) answer.mutate(digits)
          }}
        />
        <button className="button button-quiet" type="button" onClick={onDone}>
          <span className="button-label">Cancel</span>
        </button>
      </div>
    </form>
  )
}

export function AddAddress() {
  const [sent, setSent] = useState<Sent>()

  return sent === undefined ? (
    <AskForAddress onSent={setSent} />
  ) : (
    <AnswerCode
      sent={sent}
      onDone={() => {
        setSent(undefined)
      }}
    />
  )
}
