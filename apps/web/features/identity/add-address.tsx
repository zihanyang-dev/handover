/**
 * Adding another address that opens this account.
 *
 * Two steps, the same two as signing in, because proving an address is the same act whoever is
 * asking. What differs is only what the proof is spent on, and that is the server's business.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { ExclamationCircleFill } from 'react-bootstrap-icons'
import { api, reasonOf, retryKey, retryKeyDone } from '../../api.ts'
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

function Said({
  id,
  thrown,
  fallback,
}: {
  readonly id: string
  readonly thrown: unknown
  readonly fallback: string
}) {
  return (
    <p id={id} className="said said-bad" role="alert">
      <ExclamationCircleFill aria-hidden />
      {SAID[reasonOf(thrown) ?? ''] ?? fallback}
    </p>
  )
}

/** What sending a code left behind: which address, which letter to answer, and how long it is. */
type Sent = { readonly address: string; readonly id: string; readonly digits: number }

function AskForAddress({ onSent }: { readonly onSent: (sent: Sent) => void }) {
  const field = useId()
  const error = useId()
  const [address, setAddress] = useState('')

  const send = useMutation({
    mutationFn: async (to: string): Promise<Sent> => {
      const { data, error } = await api.POST('/me/credentials/email-codes', {
        body: { email: to, requestKey: retryKey(`attach:${to}`) },
      })
      if (data === undefined) throw error
      return { address: to, id: data.codeId, digits: data.digits }
    },
    onSuccess: onSent,
  })

  return (
    <form
      className="mt-5"
      onSubmit={(event) => {
        event.preventDefault()
        send.mutate(address.trim())
      }}
    >
      {send.isError && (
        <Said
          id={error}
          thrown={send.error}
          fallback="That could not be sent. Try again shortly."
        />
      )}

      <label
        className="mb-1 block text-[12px] leading-4 font-normal text-panel-ink-muted"
        htmlFor={field}
      >
        Add another email
      </label>
      <div className="flex max-w-[480px] items-center gap-2">
        <input
          id={field}
          className="h-8 min-w-0 flex-1 rounded-[5px] border border-panel-line-firm bg-white px-3 text-[14px] leading-5 text-panel-ink outline-none transition-colors placeholder:text-panel-ink-off focus:border-focus focus:ring-1 focus:ring-focus"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={address}
          aria-invalid={send.isError}
          aria-describedby={send.isError ? error : undefined}
          onChange={(event) => {
            setAddress(event.target.value)
          }}
        />
        <button
          className="h-8 shrink-0 cursor-pointer rounded-[6px] border-0 bg-primary px-3 text-[13px] leading-[16.8px] font-medium text-white hover:bg-primary-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={address.trim() === '' || send.isPending}
        >
          {send.isPending ? 'Sending…' : 'Send a code'}
        </button>
      </div>
    </form>
  )
}

function AnswerCode({ sent, onDone }: { readonly sent: Sent; readonly onDone: () => void }) {
  const client = useQueryClient()
  const field = useId()
  const error = useId()
  const [code, setCode] = useState('')

  const answer = useMutation({
    mutationFn: async (digits: string) => {
      const { error, response } = await api.POST('/me/credentials', {
        body: { codeId: sent.id, code: digits },
      })
      // Whatever it was. No reason to read means the server did not answer in the shape it
      // promises, and `reasonOf` says nothing about that rather than inventing a word for it.
      if (!response.ok) throw error
      retryKeyDone(`attach:${sent.address}`)
    },
    onSuccess: async () => {
      onDone()
      await client.invalidateQueries({ queryKey: ME })
    },
  })

  return (
    <form
      className="mt-5"
      onSubmit={(event) => {
        event.preventDefault()
        // Enter, with the code half typed. All of them go by themselves, so this can only ever be
        // an incomplete one — and sending it spends an attempt on a code nobody finished.
        if (code.length === sent.digits) answer.mutate(code)
      }}
    >
      {answer.isError && (
        <Said id={error} thrown={answer.error} fallback="That could not be checked. Try again." />
      )}

      <label
        className="mb-1 block text-[12px] leading-4 font-normal text-panel-ink-muted"
        htmlFor={field}
      >
        Code sent to {sent.address}
      </label>
      <div className="flex max-w-[360px] items-center gap-2">
        <input
          id={field}
          className="h-8 min-w-0 flex-1 rounded-[5px] border border-panel-line-firm bg-white px-3 text-[14px] leading-5 tracking-[0.16em] text-panel-ink outline-none transition-colors focus:border-focus focus:ring-1 focus:ring-focus"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={sent.digits}
          autoFocus
          value={code}
          aria-invalid={answer.isError}
          aria-describedby={answer.isError ? error : undefined}
          onChange={(event) => {
            const digits = event.target.value.replaceAll(/\D/gu, '').slice(0, sent.digits)
            setCode(digits)
            // All of them and nothing left to decide. The digits go straight in: submitting the
            // form would read a `code` this keystroke has not reached yet, and hand back one short.
            if (digits.length === sent.digits) answer.mutate(digits)
          }}
        />
        <button
          className="h-8 shrink-0 cursor-pointer rounded-md border-0 bg-transparent px-2 text-[14px] leading-[16.8px] font-medium text-panel-ink-muted hover:bg-panel-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          type="button"
          onClick={onDone}
        >
          Cancel
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
