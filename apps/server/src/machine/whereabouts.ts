/**
 * Whether a machine is here, as everything that shows one says it.
 *
 * One shape and one translation, because two of them would be two answers to the same question:
 * the machines list and the piece of work beside a conversation both have to say "its machine is
 * not here", and a page that met two spellings of that would have to know which it was looking at.
 */

import { z } from '@hono/zod-openapi'
import { presence, type Whereabouts } from './presence.ts'

export const Presence = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('here') }),
    /** `since` is when we last had evidence either way — not when it went. */
    z.object({ state: z.literal('gone'), since: z.iso.datetime() }),
  ])
  .openapi('Presence')

/**
 * What the tables know, in the shape the wire uses.
 *
 * `asOf` comes from the database rather than this process: whether a machine counts as here is a
 * comparison against a clock, and the clock that wrote `last_seen_at` is the one to compare with.
 */
export function onTheWire(where: Whereabouts, asOf: Date): z.infer<typeof Presence> {
  const found = presence(where, asOf)

  return found.state === 'here'
    ? { state: 'here' }
    : { state: 'gone', since: found.since.toISOString() }
}
