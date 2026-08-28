/**
 * Everything waiting on you, across every Space.
 *
 * The only screen in this product that is not under a Space, and that is the whole point: work
 * you handed out is work you answer for wherever it happens to live. Somebody with three Spaces
 * has one Inbox.
 *
 * It is also the only brake. There is no budget and no ceiling on a piece of work handed over —
 * what stops one is a person, and this is where a person finds out they are needed. A piece of
 * work waiting on you that is not on this list is a piece of work that will never move again.
 */

import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { inbox } from './talking.ts'

export function Inbox() {
  const heading = useId()
  const waiting = useQuery(inbox())
  const on = waiting.data ?? []

  return (
    <section className="panel" aria-labelledby={heading}>
      <div className="panel-head">
        <h2 id={heading}>Waiting on you</h2>
        {on.length > 0 && <span className="chip">{on.length}</span>}
      </div>

      {/* Three different things. A read that failed is not "nothing needs you", and saying it is
          would be this page telling somebody they can go to bed. */}
      {waiting.isError && <p className="empty">Could not read your Inbox. Try again.</p>}
      {waiting.isPending && <p className="empty">Looking…</p>}
      {waiting.isSuccess && on.length === 0 && (
        <p className="empty">Nothing needs you. Anything handed over is carrying on by itself.</p>
      )}

      <ul className="rows">
        {on.map((one) => (
          <li key={one.conversationId} className="row">
            <span className="row-name inbox-row-copy">
              <strong>{one.goal}</strong>
              {/* What it asked, because that is what somebody is answering. A row that only says
                  a piece of work is stuck makes them open it to find out what for. */}
              <span className="note">{one.asked ?? 'It stopped without saying why.'}</span>
            </span>
            <span className="row-where">
              {one.spaceSlug} · {one.machineName}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
