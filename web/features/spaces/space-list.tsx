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

      {/* Zero, one and many read the same way. There is no first-Space case to be caught in. */}
      {spaces.length === 0 ? (
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
