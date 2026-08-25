/** The Spaces somebody is in, oldest first. No "recently visited": there is no such fact. */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { meQuery } from '../identity/me.ts'

export function SpaceList() {
  const me = useQuery(meQuery)
  const spaces = me.data?.spaces ?? []

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Your Spaces</h2>
      </div>

      {/* Three different things. "None yet" is a sentence somebody acts on — they go and make one
          — and saying it while the answer is still coming, or because it never came, sends them
          to make a second Space they already have. */}
      {me.isPending && <p className="empty">Looking…</p>}

      {me.isError && <p className="empty">Could not read your Spaces. Try again.</p>}

      {/* Zero, one and many read the same way. There is no first-Space case to be caught in. */}
      {me.isSuccess && spaces.length === 0 ? (
        <p className="empty">None yet.</p>
      ) : (
        <ul className="rows">
          {spaces.map((space) => (
            <li key={space.id} className="row">
              <span className="row-name">
                <strong>{space.displayName}</strong>
              </span>
              <Link className="row-where" to="/s/$slug" params={{ slug: space.slug }}>
                /s/{space.slug}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
