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
import { Inbox as InboxIcon } from 'react-bootstrap-icons'
import { inbox } from './talking.ts'

export function Inbox() {
  const heading = useId()
  const sectionHeading = useId()
  const waiting = useQuery(inbox())
  const on = waiting.data ?? []

  return (
    <section className="inbox-page" aria-labelledby={heading}>
      <header className="inbox-header">
        <div>
          <h1 id={heading}>Inbox</h1>
          <p>Work that needs your decision, across every workspace.</p>
        </div>
        {on.length > 0 && <span className="chip">{on.length}</span>}
      </header>

      <div className="inbox-body">
        <div className="inbox-section-head">
          <h2 id={sectionHeading}>Waiting on you</h2>
        </div>

        {/* Three different things. A read that failed is not "nothing needs you", and saying it is
            would be this page telling somebody they can go to bed. */}
        {waiting.isError && (
          <p className="inbox-state" role="alert">
            Could not read your Inbox. Try again.
          </p>
        )}
        {waiting.isPending && (
          <p className="inbox-state" role="status">
            Looking…
          </p>
        )}
        {waiting.isSuccess && on.length === 0 && (
          <div className="inbox-empty" role="status">
            <span className="inbox-empty-icon" aria-hidden="true">
              <InboxIcon />
            </span>
            <strong>You're all caught up</strong>
            <p>Nothing needs you. Anything handed over is carrying on by itself.</p>
          </div>
        )}

        <ul className="inbox-rows" aria-labelledby={sectionHeading}>
          {on.map((one) => (
            <li key={one.conversationId}>
              <Link
                className="inbox-row-link"
                to="/s/$slug/c/$id"
                params={{ slug: one.spaceSlug, id: one.conversationId }}
              >
                <span className="inbox-row-copy">
                  <strong>{one.goal}</strong>
                  {/* What it asked, because that is what somebody is answering. A row that only says
                      a piece of work is stuck makes them open it to find out what for. */}
                  <span>{one.asked ?? 'It stopped without saying why.'}</span>
                </span>
                <span className="inbox-row-where">
                  {one.spaceSlug} · {one.machineName}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
