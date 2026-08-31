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
import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { inbox } from './inbox-query.ts'

function CaughtUp() {
  return (
    <section className="panel inbox-panel inbox-panel-caught-up" aria-label="Inbox">
      <div className="inbox-empty-state">
        <div className="inbox-empty-check-wrap">
          {/* Source shape: the live Notion Inbox empty state. */}
          <svg className="inbox-empty-check" aria-hidden="true" viewBox="0 0 20 20">
            <path d="M15.784 4.002a.625.625 0 0 1 .214.857L9.445 15.784a.625.625 0 0 1-1.01.085l-4.37-5.098a.625.625 0 0 1 .948-.814l3.806 4.44 6.109-10.181a.625.625 0 0 1 .857-.214" />
          </svg>
        </div>
        <p className="inbox-empty-copy">You’re all caught up</p>
      </div>
    </section>
  )
}

export function Inbox() {
  const heading = useId()
  const waiting = useQuery(inbox())
  const on = waiting.data ?? []

  if (waiting.isSuccess && on.length === 0) return <CaughtUp />

  return (
    <section className="panel inbox-panel" aria-labelledby={heading}>
      <div className="panel-head">
        <h2 id={heading}>Waiting on you</h2>
        {on.length > 0 && <span className="chip">{on.length}</span>}
      </div>

      {/* Three different things. A read that failed is not "all caught up", and saying it is
          would be this page telling somebody they can go to bed. */}
      {waiting.isError && (
        <p className="empty" role="alert">
          Could not read your Inbox. Try again.
        </p>
      )}
      {waiting.isPending && (
        <p className="empty" role="status">
          Looking…
        </p>
      )}

      <ul className="rows">
        {on.map((one) => (
          <li key={one.conversationId}>
            <Link
              className="row inbox-row-link"
              to="/s/$slug/c/$id"
              params={{ slug: one.spaceSlug, id: one.conversationId }}
            >
              <span className="row-name inbox-row-copy">
                <strong>{one.goal}</strong>
                {/* What it asked, because that is what somebody is answering. A row that only says
                    a piece of work is stuck makes them open it to find out what for. */}
                <span className="note">{one.asked ?? 'It stopped without saying why.'}</span>
              </span>
              <span className="row-where">
                {one.spaceSlug} · {one.machineName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
