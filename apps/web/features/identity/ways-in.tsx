/**
 * How you get into this account.
 *
 * Read, never stored. Two states per way and nothing else — a third would be a state somebody has
 * to reason about, and there are only two things that can be true: it works, or it can be added.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { Github, Google, Key } from 'react-bootstrap-icons'
import type { ReactElement } from 'react'
import { api } from '../../api.ts'
import { meQuery } from './me.ts'

const LOOKS: Record<string, { readonly label: string; readonly icon: ReactElement }> = {
  'email-code': { label: 'Emailed code', icon: <Key aria-hidden /> },
  google: { label: 'Google', icon: <Google aria-hidden /> },
  github: { label: 'GitHub', icon: <Github aria-hidden /> },
}

export function WaysIn() {
  const me = useQuery(meQuery)

  const connect = useMutation({
    mutationFn: async (provider: string) => {
      const { data } = await api.POST('/me/sign-in-methods/{provider}/start', {
        params: { path: { provider } },
        body: { next: '/' },
      })
      if (data !== undefined) globalThis.location.href = data.url
    },
  })

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>How you get in</h2>
      </div>

      <ul className="rows">
        {(me.data?.waysIn ?? []).map((way) => (
          <li key={way.kind} className="row">
            <span className="row-name">
              {LOOKS[way.kind]?.icon}
              <strong>{LOOKS[way.kind]?.label ?? way.kind}</strong>
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
        ))}
      </ul>

      {/*
        This says the thing somebody needs to know before deciding whether to add another way:
        whoever can read this inbox can get in. That is the direct consequence of one address
        meaning one account, and it belongs next to the list, not in a settings page.
      */}
      <p className="note" style={{ marginTop: '0.75rem' }}>
        Any of these reaches this account. The emailed code always works, because the account is
        that address.
      </p>
    </section>
  )
}
