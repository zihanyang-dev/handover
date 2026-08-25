/**
 * The conversations in this Space.
 *
 * Newest first, and each one says what was asked rather than a name somebody had to invent: the
 * first thing said is what anybody scanning this list is actually looking for.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { ChatDots } from 'react-bootstrap-icons'
import { agentName } from '../agents.ts'
import { conversationsIn } from './talking.ts'

export function Conversations({ slug }: { readonly slug: string }) {
  const heading = useId()
  const conversations = useQuery(conversationsIn(slug))
  const open = conversations.data ?? []

  return (
    <section className="panel" aria-labelledby={heading}>
      <div className="panel-head">
        <h2 id={heading}>Conversations</h2>
      </div>

      {/* Three different things. A failed read is not "none", and saying it is would send
          somebody to start a conversation they may already be having. */}
      {conversations.isError && (
        <p className="empty">Could not read the conversations here. Try again.</p>
      )}

      {conversations.isPending && <p className="empty">Looking…</p>}

      {conversations.isSuccess && open.length === 0 && (
        <p className="empty">
          Nothing yet. Pick an agent on one of your machines above to start talking to it.
        </p>
      )}

      <ul className="rows">
        {open.map((one) => (
          <li key={one.id} className="row">
            <span className="row-name">
              <ChatDots aria-hidden />
              <Link to="/s/$slug/c/$id" params={{ slug, id: one.id }}>
                {one.opening ?? 'Nothing said yet'}
              </Link>
              <span className="note">
                {agentName(one.agentKind)} on {one.machineName}
              </span>
            </span>
            {one.working.state === 'working' && <span className="chip chip-ready">Working</span>}
            {one.working.state === 'unknown' && <span className="note">Nobody knows</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
