/**
 * The browsers this instance is holding open on a conversation.
 *
 * A map and nothing else, and that is the point: the fan-out *across* instances is the
 * notification Postgres carries, and what is left on this side is handing one moment to the
 * connections this process happens to have. Nothing here is a fact, nothing is stored, and it
 * dies with the process — the same shape as `machine/waiting.ts`, which holds a machine's
 * question the same way for the same reason.
 *
 * It lives here rather than in `db/` because it touches no database at all. Written there it
 * looked like part of the transaction that announces a moment; it is the other half of the
 * journey, after Postgres has done its part.
 */

import type { Happening, Watched } from './live.ts'

export type Watchers = {
  /** Adds one, and hands back the way to take it away again. */
  readonly watch: (conversationId: string, see: (watched: Watched) => void) => () => void
  /** Shows one thing to everybody watching that conversation here, and to nobody if nobody is. */
  readonly show: (happening: Happening) => void
}

export function watchers(): Watchers {
  const here = new Map<string, Set<(watched: Watched) => void>>()

  return {
    watch: (conversationId, see) => {
      const on = here.get(conversationId) ?? new Set<(watched: Watched) => void>()
      on.add(see)
      here.set(conversationId, on)

      return () => {
        on.delete(see)
        // The last watcher of a conversation takes its name with it, so a server that has been up
        // for a month is not holding one empty set per conversation anybody ever opened.
        if (on.size === 0) here.delete(conversationId)
      }
    },

    show: (happening) => {
      for (const see of here.get(happening.conversationId) ?? []) see(happening.watched)
    },
  }
}
