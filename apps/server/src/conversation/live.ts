/**
 * What somebody watching sees while a turn is running.
 *
 * The same translation the transcript gets, pushed as it happens and kept nowhere. Two of these
 * never reach the transcript at all — what the agent is thinking, and that it has started
 * something — because both exist only to show a turn in motion. A row per streamed fragment would
 * be an update per fragment, and Postgres keeps every version of a row it updates.
 *
 * So the live stream is not a second truth. It is the same words, earlier and briefly: what is
 * stored is what was settled, and what is watched is what is happening. `prd.md` puts that
 * difference in front of the person rather than leaving them to discover it.
 */

import { z } from '@hono/zod-openapi'

const named = { name: z.string().max(200), verb: z.string().max(50), arg: z.string().max(2000) }

/** Whatever an agent's own SDK reports, in our words. Every adapter produces exactly this. */
export const Moment = z
  .discriminatedUnion('said', [
    z.object({ said: z.literal('text'), text: z.string().max(20_000) }),
    /** Live only. Worth watching, worth nothing afterwards. */
    z.object({ said: z.literal('thinking'), text: z.string().max(20_000) }),
    /** Live only. It started something; the record of it is the `did` that follows. */
    z.object({ said: z.literal('doing'), ...named }),
    z.object({ said: z.literal('trouble'), text: z.string().max(20_000) }),
    z.object({
      said: z.literal('did'),
      ...named,
      /** Absent when the tool never says how it went. Not everything reports a verdict. */
      ok: z.boolean().optional(),
      excerpt: z.string().max(4000),
    }),
  ])
  .openapi('Moment')

export type Moment = z.infer<typeof Moment>

/**
 * One moment, and which conversation it belongs to.
 *
 * Carried together because a moment on its own says nothing about who should see it, and every
 * reader here is watching one conversation rather than all of them.
 */
export const Happening = z.object({ conversationId: z.uuid(), moment: Moment })

export type Happening = z.infer<typeof Happening>

/**
 * Where moments go, and where they come from.
 *
 * An interface rather than a module, because a server that answers a browser and a server that
 * hears from a machine are usually not the same process — and what stands between them is this
 * side's business, not the transcript's.
 */
export type Live = {
  /** Says it to everyone watching that conversation, wherever they are connected. */
  readonly say: (happening: Happening) => Promise<void>
  /** Watches one conversation. The returned function stops watching. */
  readonly watch: (conversationId: string, see: (moment: Moment) => void) => () => void
}
