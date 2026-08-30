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
import { conversationReachableBy } from '../db/conversation.ts'
import { nameOf } from '../db/user.ts'
import { sayLiveFromMachine } from '../db/watching.ts'
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

/** Enough transient frames for a slow tab without allowing a disconnected socket to grow forever. */
const MAX_PENDING_FRAMES = 128

type Frame = { readonly data: string; readonly event?: string }
type PendingFrame = { readonly frame: Frame; readonly disposable: boolean }

type FrameWriter = {
  readonly push: (frame: Frame, disposable?: boolean) => void
  readonly drain: () => Promise<void>
}

export function liveApi(deps: LiveApi) {
  return [watching(deps), typing(deps), reporting(deps)]
}

/** One active write and a bounded queue, instead of one retained Promise per event. */
function frameWriter(write: (frame: Frame) => Promise<unknown>): FrameWriter {
  const pending: PendingFrame[] = []
  let writing: Promise<void> | undefined

  async function writePending(): Promise<void> {
    try {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        await write(next.frame)
      }
    } catch {
      // A closed stream has no reader for queued frames; Hono owns the socket cleanup.
      pending.length = 0
    } finally {
      writing = undefined
    }
  }

  function push(frame: Frame, disposable = false): void {
    if (pending.length === MAX_PENDING_FRAMES) {
      const disposableAt = pending.findIndex((one) => one.disposable)
      pending.splice(disposableAt < 0 ? 0 : disposableAt, 1)
    }

    pending.push({ frame, disposable })
    if (writing === undefined) writing = writePending()
  }

  async function drain(): Promise<void> {
    while (writing !== undefined) await writing
  }

  return { push, drain }
}

function mayDrop(watched: Watched): boolean {
  return watched.seen === 'moment' && watched.moment.said !== 'doing'
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
      const canWatch = {
        conversationId,
        spaceId: c.get('space').id,
        userId: c.get('userId'),
      }
      const reachable = await conversationReachableBy(db, canWatch)
      if (!reachable) return refused(c, UNAVAILABLE)

      return streamSSE(c, async (stream) => {
        let stop = (): void => undefined
        // Asked again before every frame, and that is the point of it: the check above answered
        // at the moment the stream opened, and a stream stays open for as long as somebody is
        // looking. Taken out of the Space in the meantime, they would go on being told what an
        // agent is doing on a machine they can no longer reach — which is the one thing
        // `rules/revoked.spec.ts` exists to stop.
        const writer = frameWriter(async (frame) => {
          if (!(await conversationReachableBy(db, canWatch))) {
            stop()
            await stream.close()
            throw new Error('live stream access ended')
          }
          await stream.writeSSE(frame)
        })
        stop = live.watch(conversationId, (watched) => {
          writer.push({ data: JSON.stringify(watched) }, mayDrop(watched))
        })

        stream.onAbort(stop)

        // Held open by this loop rather than by the watcher: the callback above returns at once,
        // and a handler that returned would close the stream under everybody watching it.
        while (!stream.closed && !stream.aborted) {
          await stream.sleep(HEARTBEAT_MS)
          writer.push({ data: '', event: 'still-here' }, true)
          await writer.drain()
        }

        stop()
        await writer.drain()
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
function reporting({ db }: LiveApi) {
  return aMachine(db).post('/machines/current/conversations/{id}/live', {
    summary: 'Say what is happening right now, which is kept nowhere',
    params: { id: rowId },
    body: Unkept,
    answers: {
      204: 'Said to whoever is watching, and to nobody if nobody is',
      404: refuses(UNAVAILABLE, 'That conversation was not given to this machine'),
    },

    run: async (c) => {
      const conversationId = c.req.valid('param').id
      const said = await sayLiveFromMachine(db, {
        conversationId,
        machineId: c.get('machineId'),
        watched: { seen: 'moment', moment: c.req.valid('json') },
      })
      if (!said) return refused(c, UNAVAILABLE)

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
    answers: {
      204: 'Said to whoever is watching, and to nobody if nobody is',
      404: refuses(UNAVAILABLE, 'No such Space, or no such conversation in it'),
    },

    run: async (c) => {
      const conversationId = c.req.valid('param').id
      const reachable = await conversationReachableBy(db, {
        conversationId,
        spaceId: c.get('space').id,
        userId: c.get('userId'),
      })
      if (!reachable) return refused(c, UNAVAILABLE)

      await live.say({
        conversationId,
        watched: {
          seen: 'typing',
          userId: c.get('userId'),
          who: await nameOf(db, c.get('userId')),
        },
      })

      return nothing(c, 204)
    },
  })
}
