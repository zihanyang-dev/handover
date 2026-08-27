/**
 * Watching a turn while it runs.
 *
 * Two doors again, and the same split as everywhere else: a machine says what is happening on it,
 * a person watches one conversation they can reach. Nothing here is kept — a moment nobody was
 * watching for is simply gone, which is the whole point of it not being the transcript.
 */

import { streamSSE } from 'hono/streaming'
import { Unkept, Watched, type Live } from '../conversation/live.ts'
import type { Database } from '../db/connection.ts'
import { conversationInSpace } from '../db/conversation.ts'
import { nameOf } from '../db/user.ts'
import { UNAVAILABLE, refused } from './failure.ts'
import { aMachine, aMember, nothing, refuses, rowId, streams } from './route.ts'

export type LiveApi = {
  readonly db: Database
  readonly live: Live
}

/**
 * How often to say nothing, when there is nothing to say.
 *
 * A stream that goes quiet for minutes is one a proxy closes, and a browser cannot tell that from
 * an agent that has gone quiet. A comment line keeps the connection honest and costs two bytes.
 */
const HEARTBEAT_MS = 20_000

export function liveApi(deps: LiveApi) {
  return [watching(deps), typing(deps), reporting(deps)]
}

/** What is happening right now, for as long as somebody is looking. */
function watching({ db, live }: LiveApi) {
  return aMember(db).get('/spaces/{slug}/conversations/{id}/live', {
    summary: 'Watch a turn while it runs',
    params: { id: rowId },
    answers: {
      200: streams(Watched, 'One thing per event, until the browser goes away'),
      404: refuses(UNAVAILABLE, 'No such Space, or no such conversation in it'),
    },

    run: async (c) => {
      // Asked once, before anything is opened: a stream is a reachable conversation held open,
      // and whether it is reachable is the same question every other route here asks. Only that,
      // though — what has been said in it is the transcript's to answer, and this never shows it.
      const conversationId = c.req.valid('param').id
      const reachable = await conversationInSpace(db, {
        conversationId,
        spaceId: c.get('space').id,
      })
      if (!reachable) return refused(c, UNAVAILABLE)

      return streamSSE(c, async (stream) => {
        const sending: Promise<unknown>[] = []
        const stop = live.watch(conversationId, (watched) => {
          sending.push(stream.writeSSE({ data: JSON.stringify(watched) }))
        })

        stream.onAbort(stop)

        // Held open by this loop rather than by the watcher: the callback above returns at once,
        // and a handler that returned would close the stream under everybody watching it.
        while (!stream.closed && !stream.aborted) {
          await stream.sleep(HEARTBEAT_MS)
          await stream.writeSSE({ data: '', event: 'still-here' })
        }

        stop()
        await Promise.allSettled(sending)
      })
    },
  })
}

/**
 * What the machine running a turn is seeing, as it sees it.
 *
 * Only the two that are never kept. Everything else it has to say goes into the transcript, and
 * the transcript announces itself when it is written — sending it here as well would be the same
 * sentence crossing the network twice and arriving in two orders.
 */
function reporting({ db, live }: LiveApi) {
  return aMachine(db).post('/machines/current/conversations/{id}/live', {
    summary: 'Say what is happening right now, which is kept nowhere',
    params: { id: rowId },
    body: Unkept,
    answers: { 204: 'Said to whoever is watching, and to nobody if nobody is' },

    run: async (c) => {
      // No check that this machine owns the conversation, and none that it exists: a moment is
      // shown to whoever is already watching that id and kept nowhere, so the worst a wrong id can
      // do is say something to a screen its own machine is not driving — and only a live machine
      // credential can say anything at all. Checking would put a query in front of every fragment
      // of every turn, to guard nothing that lasts.
      await live.say({
        conversationId: c.req.valid('param').id,
        watched: { seen: 'moment', moment: c.req.valid('json') },
      })

      return nothing(c, 204)
    },
  })
}

/**
 * Somebody has the box open and is typing.
 *
 * Kept nowhere, like everything else on this channel. It is not a fact about the conversation —
 * it is what this second looks like — and a Space where two people can both answer an agent is
 * one where each of them needs to know the other is halfway through a sentence.
 *
 * Said again every few seconds rather than paired with a "stopped". A browser that was closed, a
 * laptop that slept and a network that went cannot send the second half, so whoever is watching
 * forgets on their own instead. Nothing here has any state to leak.
 *
 * The name comes from the session, not the body: an endpoint that reads who is typing out of what
 * it was sent is an endpoint that lets anybody type as anybody.
 */
function typing({ db, live }: LiveApi) {
  return aMember(db).post('/spaces/{slug}/conversations/{id}/typing', {
    summary: 'Say that you are typing, which is kept nowhere',
    params: { id: rowId },
    answers: { 204: 'Said to whoever is watching, and to nobody if nobody is' },

    run: async (c) => {
      // The same reasoning as a machine's moment: shown to whoever is already watching that id and
      // kept nowhere, so a wrong id costs a line on a screen and nothing else. Membership has
      // already been asked, which is the part that matters.
      await live.say({
        conversationId: c.req.valid('param').id,
        watched: { seen: 'typing', who: await nameOf(db, c.get('userId')) },
      })

      return nothing(c, 204)
    },
  })
}
