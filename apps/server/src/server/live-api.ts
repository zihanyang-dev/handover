/**
 * Watching a turn while it runs.
 *
 * Two doors again, and the same split as everywhere else: a machine says what is happening on it,
 * a person watches one conversation they can reach. Nothing here is kept — a moment nobody was
 * watching for is simply gone, which is the whole point of it not being the transcript.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import { Moment, type Live } from '../conversation/live.ts'
import { conversationWith } from '../db/conversation.ts'
import type { Database } from '../db/connection.ts'
import { SHOWS, api, endpointsBehind, rowId, saysNothing, streams, takes } from './contract.ts'
import {
  BEHIND_A_MACHINE,
  BEHIND_A_SESSION,
  body,
  MALFORMED_BODY,
  refusal,
  UNAVAILABLE,
} from './failure.ts'
import { requireMachine, type Attached } from './machine-session.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

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

const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>(SHOWS.session)
const behindAMachine = endpointsBehind<{ Variables: Attached }>(SHOWS.machine)

export function liveApi(deps: LiveApi) {
  return api<{ Variables: Signed & InSpace }>()
    .openapiRoutes([watching(deps)])
    .route('/', api<{ Variables: Attached }>().openapiRoutes([reporting(deps)]))
}

/** What is happening right now, for as long as somebody is looking. */
function watching(deps: LiveApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/conversations/{id}/live',
      summary: 'Watch a turn while it runs',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), id: rowId }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: streams(Moment, 'One moment per event, until the browser goes away'),
        404: refusal('No such Space, or no such conversation in it'),
      },
    }),

    handler: async (c) => {
      // Read once, before anything is opened: a stream is a reachable conversation held open, and
      // whether it is reachable is the same question every other route here asks.
      const reachable = await conversationWith(deps.db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
      })
      if (reachable === undefined) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)

      const conversationId = reachable.id

      return streamSSE(c, async (stream) => {
        const sending: Promise<unknown>[] = []
        const stop = deps.live.watch(conversationId, (moment) => {
          sending.push(stream.writeSSE({ data: JSON.stringify(moment) }))
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

/** What the machine running a turn is seeing, as it sees it. */
function reporting(deps: LiveApi) {
  return behindAMachine({
    route: createRoute({
      method: 'post',
      path: '/machines/current/conversations/{id}/live',
      summary: 'Say what is happening right now, which is kept nowhere',
      middleware: [requireMachine(deps.db)],
      request: { params: z.object({ id: rowId }), body: takes(Moment) },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        204: saysNothing('Said to whoever is watching, and to nobody if nobody is'),
      },
    }),

    handler: async (c) => {
      // No check that this machine owns the conversation, and none that it exists: a moment is
      // shown to whoever is already watching that id and kept nowhere, so the worst a wrong id can
      // do is say something to a screen its own machine is not driving — and only a live machine
      // credential can say anything at all. Checking would put a query in front of every fragment
      // of every turn, to guard nothing that lasts.
      await deps.live.say({ conversationId: c.req.valid('param').id, moment: c.req.valid('json') })

      return c.body(null, 204)
    },
  })
}
