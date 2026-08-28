import { PIECE, utf8Length } from '@handover/universal'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Agent, EXCERPT, type Said, type Told, shorten } from './agents/agent.ts'
import { startAnswering, type Asking } from './answering.ts'
import { apiFor } from './api.ts'

const server = setupServer()
const ORIGIN = 'http://handover.test'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const ASKING: Asking = {
  conversationId: 'c-1',
  agentKind: 'claude-code',
  agentSession: null,
  goal: null,
  where: { kind: 'its-own' },
  hasRunBefore: false,
  afterSeq: 4,
  asked: [{ text: 'read notes.txt', who: 'Kai' }],
  model: null,
  effort: null,
}

type Written = { readonly key: string; readonly message: { role: string; content: unknown } }

let written: Written[] = []
let named: string[] = []
let watched: Said[] = []

beforeEach(() => {
  written = []
  named = []
  watched = []
  server.use(
    http.post(`${ORIGIN}/machines/current/conversations/:id/messages`, async ({ request }) => {
      written.push((await request.json()) as Written)
      return new HttpResponse(null, { status: 204 })
    }),
    http.put(`${ORIGIN}/machines/current/conversations/:id/session`, async ({ request }) => {
      named.push(((await request.json()) as { session: string }).session)
      return new HttpResponse(null, { status: 204 })
    }),
    http.post(`${ORIGIN}/machines/current/conversations/:id/live`, async ({ request }) => {
      watched.push((await request.json()) as Said)
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

/** An agent that says exactly what a test tells it to and then stops. */
function saying(...told: readonly Told[]): Agent {
  return {
    command: 'pretend',
    offers: async () => [],
    talk: () => ({
      say: async function* () {
        yield* told
      },
      stop: async () => {},
    }),
  }
}

async function answered(agent: Agent): Promise<readonly Written[]> {
  const machine = {
    workRoot: '/nowhere',
    handover: 'handover',
    env: {},
    say: () => undefined,
    until: new AbortController().signal,
  }
  await startAnswering(apiFor(ORIGIN, 'hm_t'), ASKING, agent, { machine, where: '/nowhere' }).done

  return written
}

const said = (said: Said): Told => ({ told: 'said', said })

describe('what a turn leaves behind', () => {
  it('writes what it said and how it went', async () => {
    const kept = await answered(
      saying(said({ said: 'text', text: 'the timeout is 30 seconds' }), {
        told: 'ended',
        why: { why: 'done' },
      }),
    )

    expect(kept.map((one) => one.message)).toEqual([
      { role: 'assistant', content: { text: 'the timeout is 30 seconds' } },
      { role: 'activity', content: { activityType: 'done' } },
    ])
  })

  it('never writes down what it was thinking', async () => {
    // Worth watching while it happens and worth nothing afterwards. Claude Code agrees with
    // itself: the thinking in its own session file carries a signature and no readable text.
    const kept = await answered(
      saying(
        said({ said: 'thinking', text: 'let me look at the file' }),
        said({ said: 'text', text: 'done' }),
        { told: 'ended', why: { why: 'done' } },
      ),
    )

    expect(JSON.stringify(kept)).not.toContain('let me look at the file')
  })

  it('shows the whole of what a command printed, and keeps only the beginning', async () => {
    // `prd.md` 03 ⑦ is a table with one row that differs between watching and coming back, and
    // this is that row: the full output while it runs, a first paragraph a day later.
    const long = '界'.repeat(EXCERPT * 3)
    const kept = await answered(
      saying(
        said({
          said: 'did',
          callId: 'long-command',
          name: 'Bash',
          verb: 'ran',
          arg: 'cat big.log',
          excerpt: shorten(long),
          output: long,
        }),
        { told: 'ended', why: { why: 'done' } },
      ),
    )

    // Watching: all of it, in pieces small enough to cross a NOTIFY payload.
    const printed = watched.filter((one) => one.said === 'output')
    expect(printed.map((one) => one.text).join('')).toBe(long)
    for (const piece of printed) expect(utf8Length(piece.text)).toBeLessThanOrEqual(PIECE)

    // Coming back: the beginning, and no more than that.
    expect(JSON.stringify(kept)).toContain(shorten(long))
    expect(JSON.stringify(kept).length).toBeLessThan(long.length)
  })

  it('does not push output that the excerpt already carries whole', async () => {
    // The same words crossing the network twice, arriving twice on one screen. Short output is
    // already in the line the transcript keeps.
    await answered(
      saying(
        said({
          said: 'did',
          callId: 'short-command',
          name: 'Bash',
          verb: 'ran',
          arg: 'echo hi',
          excerpt: 'hi',
          output: 'hi',
        }),
        { told: 'ended', why: { why: 'done' } },
      ),
    )

    expect(watched.filter((one) => one.said === 'output')).toEqual([])
  })

  it('never writes down that it had started something, only that it did it', async () => {
    const kept = await answered(
      saying(
        said({ said: 'doing', callId: 'list', name: 'Bash', verb: 'ran', arg: 'ls' }),
        said({
          said: 'did',
          callId: 'list',
          name: 'Bash',
          verb: 'ran',
          arg: 'ls',
          ok: true,
          excerpt: 'a b',
        }),
        { told: 'ended', why: { why: 'done' } },
      ),
    )

    expect(kept.map((one) => one.message.role)).toEqual(['tool', 'activity'])
  })

  it('keeps a tool that never said how it went as one that never said', async () => {
    const kept = await answered(
      saying(
        said({
          said: 'did',
          callId: 'search',
          name: 'web_search',
          verb: '',
          arg: 'x',
          excerpt: '',
        }),
        { told: 'ended', why: { why: 'done' } },
      ),
    )

    expect(kept[0]?.message.content).not.toHaveProperty('ok')
  })

  it('says out loud that it did not remember, before anything else in the turn', async () => {
    // Not a failure and not silence: the page has to be able to tell somebody that this answer
    // was written by an agent with no memory of what came before it.
    const kept = await answered(
      saying({ told: 'forgot' }, said({ said: 'text', text: 'hello' }), {
        told: 'ended',
        why: { why: 'done' },
      }),
    )

    expect(kept.map((one) => one.message.content)).toEqual([
      { activityType: 'forgot' },
      { text: 'hello' },
      { activityType: 'done' },
    ])
  })

  it('records what the agent calls the conversation, without writing it as a message', async () => {
    const kept = await answered(
      saying({ told: 'session', id: 'sess-9' }, { told: 'ended', why: { why: 'done' } }),
    )

    expect(named).toEqual(['sess-9'])
    expect(kept).toHaveLength(1)
  })

  it('ends a stopped turn as stopped, not as a failure', async () => {
    const kept = await answered(saying({ told: 'ended', why: { why: 'cancelled' } }))

    expect(kept.at(-1)?.message.content).toEqual({ activityType: 'cancelled' })
  })

  it('carries a failure in words a person can read', async () => {
    const kept = await answered(
      saying({ told: 'ended', why: { why: 'failed', said: 'Claude Code is not signed in.' } }),
    )

    expect(kept.at(-1)?.message.content).toEqual({
      activityType: 'failed',
      text: 'Claude Code is not signed in.',
    })
  })

  it('bounds a failure, because what arrives there is somebody else s error', async () => {
    const kept = await answered(
      saying({ told: 'ended', why: { why: 'failed', said: 'x'.repeat(5000) } }),
    )

    const content = kept.at(-1)?.message.content as { text: string }
    expect(content.text.length).toBeLessThan(500)
  })

  it('closes a turn whose agent stopped talking without saying how it went', async () => {
    // Nobody can say what happened, and a turn left open is one a page shows as still working
    // for as long as this machine keeps reporting.
    const kept = await answered(saying(said({ said: 'text', text: 'half an answer' })))

    expect(kept.at(-1)?.message.content).toEqual({ activityType: 'unknown' })
  })

  it('names every message after the question it answers, so a lost reply can be sent again', async () => {
    const kept = await answered(
      saying(said({ said: 'text', text: 'one' }), said({ said: 'text', text: 'two' }), {
        told: 'ended',
        why: { why: 'done' },
      }),
    )

    expect(kept.map((one) => one.key)).toEqual(['4/1', '4/2', '4/end'])
  })

  it('pushes the two kinds nothing keeps, and only those', async () => {
    // Everything else is written down, and writing it is what tells whoever is watching. Pushed
    // as well, the same sentence would cross the network twice, land on the screen twice, and
    // land in two different orders whenever one of the two had to be retried.
    await answered(
      saying(
        said({ said: 'thinking', text: 'let me look at the file' }),
        said({ said: 'doing', callId: 'list', name: 'Bash', verb: 'ran', arg: 'ls' }),
        said({ said: 'text', text: 'done' }),
        { told: 'ended', why: { why: 'done' } },
      ),
    )

    expect(watched.map((one) => one.said)).toEqual(['thinking', 'doing'])
    // And the one that is kept is kept, rather than being lost between the two paths.
    expect(JSON.stringify(written)).toContain('done')
    expect(JSON.stringify(written)).not.toContain('let me look at the file')
  })

  it('will not call a turn finished when part of it never got in', async () => {
    // The agent said it was done and it may well have been — that is exactly why this is not
    // `failed`, which invites somebody to ask for it all over again. But the transcript is missing
    // lines, and a turn shown as finished beside a record with holes in it says what nobody knows.
    server.use(
      http.post(`${ORIGIN}/machines/current/conversations/:id/messages`, async ({ request }) => {
        const body = (await request.json()) as Written
        if (body.message.role === 'assistant') {
          return HttpResponse.json(
            { reason: 'malformed-request', recovery: 'retype' },
            { status: 400 },
          )
        }
        written.push(body)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const kept = await answered(
      saying(said({ said: 'text', text: 'half an answer' }), {
        told: 'ended',
        why: { why: 'done' },
      }),
    )

    expect(kept.at(-1)?.message.content).toEqual({ activityType: 'unknown' })
  })

  it('keeps trying a write nobody answered, under the same name', async () => {
    // The name is what makes trying again safe. A network comes back, and a line of the record is
    // worth more than the second or two of waiting.
    let asked = 0
    server.use(
      http.post(`${ORIGIN}/machines/current/conversations/:id/messages`, async ({ request }) => {
        asked += 1
        if (asked < 3) return HttpResponse.error()
        written.push((await request.json()) as Written)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const kept = await answered(saying({ told: 'ended', why: { why: 'done' } }))

    expect(asked).toBe(3)
    expect(kept.at(-1)?.message.content).toEqual({ activityType: 'done' })
  }, 20_000)
})
