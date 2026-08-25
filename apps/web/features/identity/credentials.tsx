/**
 * How you get into this account, and how to add another way.
 *
 * Addresses are listed one by one rather than folded into a single "emailed code" line. Folded,
 * nobody can see how many keys there are — and how many keys there are is the whole reason this
 * is on the screen.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { Key } from 'react-bootstrap-icons'
import { useId } from 'react'
import { api } from '../../api.ts'
import { AddAddress } from './add-address.tsx'
import { meQuery } from './me.ts'
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
    <section className="panel" aria-labelledby={heading}>
      <div className="panel-head">
        <h2 id={heading}>How you get in</h2>
      </div>

      <ul className="rows">
        {(me.data?.credentials ?? []).map((way) =>
          way.kind === 'email' ? (
            <li key={way.address} className="row">
              <span className="row-name">
                <Key aria-hidden />
                <strong>{way.address}</strong>
                <span className="note">Emailed code</span>
              </span>
              <span className="chip chip-ready">Ready</span>
            </li>
          ) : (
            <li key={way.kind} className="row">
              <span className="row-name">
                {PROVIDERS[way.kind].icon}
                <strong>{PROVIDERS[way.kind].label}</strong>
              </span>
              {way.state === 'ready' ? (
                <span className="chip chip-ready">Ready</span>
              ) : (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    connect.mutate(way.kind)
                  }}
                >
                  <span className="button-label">Connect</span>
                </button>
              )}
            </li>
          ),
        )}
      </ul>

      {/*
        The thing somebody needs to know before deciding to add another way: every one of these is
        a key, and whoever holds it gets in. It belongs beside the list, not in a settings page.
      */}
      <p className="note" style={{ marginTop: '0.75rem' }}>
        Any of these reaches this account. Whoever can read one of those inboxes can sign in.
      </p>

      <AddAddress />
    </section>
  )
}
