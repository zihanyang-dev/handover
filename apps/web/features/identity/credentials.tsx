/**
 * How you get into this account, and how to add another way.
 *
 * Addresses are listed one by one rather than folded into a single "emailed code" line. Folded,
 * nobody can see how many keys there are — and how many keys there are is the whole reason this
 * is on the screen.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { Envelope } from 'react-bootstrap-icons'
import { api } from '../../api.ts'
import { AddAddress } from './add-address.tsx'
import { meQuery, type Me } from './me.ts'
import { PROVIDERS } from './providers.tsx'

export function Credentials() {
  const me = useQuery(meQuery)
  const heading = useId()

  const connect = useMutation({
    mutationFn: async (provider: string) => {
      const { data } = await api.POST('/me/credentials/{provider}/start', {
        params: { path: { provider } },
        body: { next: '/' },
      })
      if (data !== undefined) globalThis.location.href = data.url
    },
  })

  return (
    // Named, so it is a region somebody can jump to rather than a run of unlabelled rows.
    <section className="mb-14.5" aria-labelledby={heading}>
      <h2
        id={heading}
        className="m-0 mb-0 border-b border-line pb-3 text-copy-s leading-6 font-medium text-ink"
      >
        How you get in
      </h2>

      <ul className="m-0 mt-2 list-none space-y-1 p-0">
        {(me.data?.credentials ?? []).map((way) => (
          <CredentialRow
            key={way.kind === 'email' ? way.address : way.kind}
            way={way}
            pending={connect.isPending}
            connect={(provider) => {
              connect.mutate(provider)
            }}
          />
        ))}
      </ul>

      {connect.isError && (
        <p className="m-0 mt-2 text-[13px] leading-5 text-danger-strong" role="alert">
          That login method could not be connected. Try again.
        </p>
      )}

      <AddAddress />
    </section>
  )
}

function CredentialRow({
  way,
  pending,
  connect,
}: {
  readonly way: Me['credentials'][number]
  readonly pending: boolean
  readonly connect: (provider: 'google' | 'github') => void
}) {
  if (way.kind === 'email')
    return (
      <li className="flex min-h-12 items-center justify-between gap-6">
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center text-ink-muted">
            <Envelope className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <strong className="block text-copy-xs leading-5 font-medium text-ink">Email</strong>
            <span className="block truncate text-copy-xxs leading-4 text-ink-muted">
              {way.address}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-[13px] leading-5 text-ink-muted">Ready</span>
      </li>
    )

  return (
    <li className="flex min-h-12 items-center justify-between gap-6">
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center">
          {PROVIDERS[way.kind].icon}
        </span>
        <strong className="min-w-0 truncate text-copy-xs leading-5 font-medium text-ink">
          {PROVIDERS[way.kind].label}
        </strong>
      </span>
      {way.state === 'ready' ? (
        <span className="shrink-0 text-[13px] leading-5 text-ink-muted">Ready</span>
      ) : (
        <button
          className="h-7 shrink-0 cursor-pointer rounded-md border-0 bg-primary px-3 text-[13px] leading-[16.8px] font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          disabled={pending}
          onClick={() => {
            connect(way.kind)
          }}
        >
          {pending ? 'Connecting…' : 'Connect'}
        </button>
      )}
    </li>
  )
}
