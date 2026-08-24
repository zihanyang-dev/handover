/**
 * Whether a machine is here right now.
 *
 * Read, never stored. Storing `online` would mean writing `offline` on the way out, and a process
 * that is killed never gets to write anything — the row would say a dead machine is here, and
 * nothing would ever correct it.
 */

/** How often a machine checks in. It holds the request open until there is something to say. */
export const POLL_SECONDS = 25

/**
 * How long silence lasts before it means gone.
 *
 * Derived from the poll rather than chosen, so the two cannot drift apart: one missed check-in is
 * a hiccup on a train, two in a row is a machine that is not coming back this second. Written as
 * its own number, somebody would tune the poll and leave this behind, and every machine would
 * flicker offline between checks.
 */
export const SILENT_FOR_SECONDS = POLL_SECONDS * 2 + 5

export type Presence =
  | { readonly state: 'here' }
  /** Not here. `since` is when we last had evidence either way, which is what a page shows. */
  | { readonly state: 'gone'; readonly since: Date }

/**
 * What the database knows about a machine's whereabouts.
 *
 * `leftAt` is set only when a machine said it was leaving. It is not derivable — nothing about a
 * timestamp says whether the silence after it was chosen — so it is the one presence fact stored.
 */
export type Whereabouts = {
  readonly lastSeenAt: Date
  readonly leftAt: Date | null
}

export function presence(where: Whereabouts, now: Date): Presence {
  // It told us it was going. No need to wait out the silence to believe it.
  if (where.leftAt !== null) return { state: 'gone', since: where.leftAt }

  const silentFor = (now.getTime() - where.lastSeenAt.getTime()) / 1000
  if (silentFor > SILENT_FOR_SECONDS) return { state: 'gone', since: where.lastSeenAt }

  return { state: 'here' }
}
