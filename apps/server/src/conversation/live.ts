/**
 * What somebody watching sees while a turn is running.
 *
 * Two things reach a watcher, and they are not the same kind of thing. One is what the agent is
 * doing right this second — what it is thinking, that it has started something — which never
 * reaches the transcript at all: a row per streamed fragment would be an update per fragment, and
 * Postgres keeps every version of a row it updates. The other is only a mark saying the
 * transcript has grown, so whoever is watching goes and reads the tail of it.
 *
 * That second one carries no words on purpose. The transcript is the one thing that survives, and
 * it is read by asking for it; a copy of it pushed down here would be a second source for the
 * same fact, which is two facts that can disagree — about what was said, and about what order it
 * was said in.
 */

import { PIECE } from '@handover/universal'
import { z } from '@hono/zod-openapi'

/**
 * What an agent reports that is never written down.
 *
 * Two of these have nowhere else to be — what it is thinking, and that it has started something.
 * The third is the one exception to "nothing is both", and it is the product asking for it:
 * `prd.md` 03 ⑦ is a table where the full output of a command reads "there" while it runs and
 * "the first paragraph" a day later. So the whole of it comes through here and the beginning of
 * it goes into the transcript. Not the same sentence twice — one is a view, the other is the
 * record, and they are deliberately different lengths.
 */
export const Unkept = z
  .discriminatedUnion('said', [
    z.object({ said: z.literal('thinking'), text: z.string().max(20_000) }),
    z.object({
      said: z.literal('doing'),
      name: z.string().max(200),
      verb: z.string().max(50),
      arg: z.string().max(2000),
    }),
    /**
     * What the command that just ran printed, whole, in pieces.
     *
     * `prd.md` 03 ⑦ is a table with one row that differs between watching and coming back: the
     * full output of a command is there while it runs and is a first paragraph afterwards. This
     * is the first half of that row, and it is not kept for the same reason thinking is not —
     * nobody scrolls back through ten kilobytes of a command they watched finish.
     *
     * In pieces because this crosses instances through Postgres `NOTIFY`, whose payload stops at
     * 8000 bytes. They arrive in order on one connection and belong to whatever is running now.
     */
    z.object({ said: z.literal('output'), text: z.string().max(PIECE) }),
  ])
  .openapi('Unkept')

export type Unkept = z.infer<typeof Unkept>

/** One thing a watcher is handed. */
export const Watched = z
  .discriminatedUnion('seen', [
    z.object({ seen: z.literal('moment'), moment: Unkept }),
    /**
     * The transcript has grown to at least this far.
     *
     * A number rather than the words: whoever is watching already knows how to ask for the tail
     * from where they had got to, and this is only what tells them there is one.
     */
    z.object({ seen: z.literal('written'), upTo: z.number().int().positive() }),
    /**
     * Somebody else has the box open and is typing.
     *
     * Never written down, like everything else here — it is not a fact, it is what this second
     * looks like, and it dies with the connection that carried it. What it prevents is two people
     * in one Space each answering an agent without knowing the other is halfway through.
     *
     * A name, not an id: it goes on a screen. And there is no matching "stopped typing", because
     * a browser that crashed cannot send one — whoever is typing says so every few seconds, and
     * whoever is watching gives up on their own. See `prd.md` 06 ③.
     */
    z.object({ seen: z.literal('typing'), who: z.string() }),
  ])
  .openapi('Watched')

export type Watched = z.infer<typeof Watched>

/**
 * One thing seen, and which conversation it belongs to.
 *
 * Carried together because neither half says anything on its own about who should see it, and
 * every reader here is watching one conversation rather than all of them.
 */
export const Happening = z.object({ conversationId: z.uuid(), watched: Watched })

export type Happening = z.infer<typeof Happening>

/**
 * Where what is happening goes, and where it comes from.
 *
 * An interface rather than a module, because a server that answers a browser and a server that
 * hears from a machine are usually not the same process — and what stands between them is this
 * side's business, not the transcript's.
 */
export type Live = {
  /** Says it to everyone watching that conversation, wherever they are connected. */
  readonly say: (happening: Happening) => Promise<void>
  /** Watches one conversation. The returned function stops watching. */
  readonly watch: (conversationId: string, see: (watched: Watched) => void) => () => void
}
