/**
 * What an agent says about the piece of work it was handed.
 *
 * The thing reading these answers is an agent, so what is under test is mostly the words: a
 * command that failed silently is one it will run again, and a command whose answer it cannot
 * read is one it will run a different way.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runTask } from './task.ts'

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

/** A machine that is connected, with its credential where the command will look for it. */
let WHERE = ''

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'handover-task-'))
  WHERE = join(home, 'machine.json')
  await writeFile(
    WHERE,
    JSON.stringify({
      origin: ORIGIN,
      machineId: '00000000-0000-4000-8000-000000000000',
      token: 'hm_test',
      lookFor: [],
    }),
  )
})

const IN: NodeJS.ProcessEnv = { HANDOVER_CONVERSATION: 'c-1' }

async function ran(words: string[], env: NodeJS.ProcessEnv = IN) {
  return runTask({ env, where: WHERE, words })
}

/** Takes the agent stopping, and keeps the `how` half of it with the name it went under. */
function stops(seen: unknown[] = []) {
  return http.patch(`${ORIGIN}/machines/current/conversations/:id/task`, async ({ request }) => {
    const body = (await request.json()) as { key: string; how: Record<string, unknown> }
    seen.push({ ...body.how, key: body.key })
    return new HttpResponse(null, { status: 204 })
  })
}

/** Takes a proposal, which goes down the path a machine already writes lines by. */
function proposals(seen: unknown[] = []) {
  return http.post(`${ORIGIN}/machines/current/conversations/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { message: { content: Record<string, unknown> } }
    seen.push(body.message.content)
    return new HttpResponse(null, { status: 204 })
  })
}

describe('finding out what it can do', () => {
  it('lists everything when it is asked, and when it is asked for nothing', async () => {
    expect((await ran(['--help'])).said).toContain('handover task')
    expect((await ran([])).said).toContain('sleep <when>')
  })

  it('says what it does not know, and shows the list with it', async () => {
    const said = await ran(['ponder', 'deeply'])

    expect(said.kind).toBe('no-such-command')
    expect(said.said).toContain('no such command: ponder')
    expect(said.said).toContain('output')
  })
})

describe('saying something about the work', () => {
  it('stops and asks, in words the person will read in their Inbox', async () => {
    const seen: unknown[] = []
    server.use(stops(seen))

    const said = await ran(['wait', 'env var, or a field on the client?'])

    expect(said.kind).toBe('did')
    expect(seen).toMatchObject([{ state: 'wait', question: 'env var, or a field on the client?' }])
  })

  it('sleeps for a length of time, and for a moment of its own', async () => {
    // Both, because both are how somebody says it: "look again in ten minutes" and "at noon on
    // Thursday" are the same instruction and neither should have to be converted by hand.
    const seen: { until: string }[] = []
    server.use(stops(seen))

    await ran(['sleep', '3h'])
    await ran(['sleep', '2030-09-03T12:00:00.000Z'])

    const soon = new Date(seen[0]?.until ?? '').getTime() - Date.now()
    expect(soon).toBeGreaterThan(2.9 * 3_600_000)
    expect(seen[1]?.until).toBe('2030-09-03T12:00:00.000Z')
  })

  it('will not guess at a moment it cannot read', async () => {
    const said = await ran(['sleep', 'later'])

    expect(said.kind).toBe('wrong')
    expect(said.said).toContain('3h')
  })

  it('tells the two endings apart, because they are two different things to a person', async () => {
    const seen: unknown[] = []
    server.use(stops(seen))

    await ran(['done', 'on branch sub/xxx'])
    await ran(['cannot', 'no database credentials on this machine'])

    expect(seen).toMatchObject([
      { state: 'done', ending: 'done' },
      { state: 'done', ending: 'cannot' },
    ])
  })

  it('writes something down at its title, so writing it again replaces it', async () => {
    // The title is the address, so nothing here carries a name to be idempotent under — the
    // address already is one.
    const seen: { at: string; text: string }[] = []
    server.use(
      http.put(
        `${ORIGIN}/machines/current/conversations/:id/task/outputs/:title`,
        async ({ request, params }) => {
          const body = (await request.json()) as { text: string }
          seen.push({ at: String(params['title']), text: body.text })
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )

    await ran(['output', 'Rollout review', 'Error rate flat at 0.02%.'])

    expect(seen).toMatchObject([{ at: 'Rollout review', text: 'Error rate flat at 0.02%.' }])
  })
})

describe('opening a piece of work', () => {
  it('puts it in front of a person when nobody is named', async () => {
    // It changes no state and creates nothing, so it goes down the path a machine already
    // writes lines by — this side of the system needs nothing new for it at all.
    const seen: unknown[] = []
    server.use(proposals(seen))

    const said = await ran(['new', 'make the timeout configurable'])

    expect(said.said).toContain('they have to agree')
    expect(seen).toMatchObject([
      { activityType: 'proposed', text: 'make the timeout configurable' },
    ])
  })

  it('hands it to another agent when one is named, and carries on', async () => {
    const seen: unknown[] = []
    server.use(
      http.post(
        `${ORIGIN}/machines/current/conversations/:id/task/handed-off`,
        async ({ request }) => {
          seen.push(await request.json())
          return HttpResponse.json({ conversationId: 'c-2' }, { status: 201 })
        },
      ),
    )

    const said = await ran(['new', 'add an integration test', '--to', 'codex@build-server-1'])

    expect(said.kind).toBe('did')
    expect(seen).toMatchObject([
      { goal: 'add an integration test', machine: 'build-server-1', agentKind: 'codex' },
    ])
  })

  it('says what --to should look like rather than sending something wrong', async () => {
    const said = await ran(['new', 'anything', '--to', 'build-server-1'])

    expect(said.kind).toBe('wrong')
    expect(said.said).toContain('@<machine>')
  })
})

describe('when there is nothing to say it about', () => {
  it('says so plainly, rather than failing in a way it will retry', async () => {
    const said = await ran(['done', 'finished'], {})

    expect(said.kind).toBe('not-handed-over')
    expect(said.said).toContain('nothing was handed over here')
  })

  it('says the same when the server does not know that conversation', async () => {
    server.use(
      http.patch(`${ORIGIN}/machines/current/conversations/:id/task`, () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'start-over' }, { status: 404 }),
      ),
    )

    expect((await ran(['done', 'finished'])).kind).toBe('not-handed-over')
  })

  it('says this machine is not connected at all, which is a different thing', async () => {
    const said = await runTask({ env: IN, where: '/nowhere/machine.json', words: ['done', 'x'] })

    expect(said.said).toContain('not connected')
  })
})

describe('running the same command twice', () => {
  it('sends the same name both times, so it lands once', async () => {
    // An agent that ran a command and never saw the answer means it once, not twice.
    const seen: { key: string }[] = []
    server.use(stops(seen))

    await ran(['wait', 'A or B?'])
    await ran(['wait', 'A or B?'])

    expect(seen[0]?.key).toBe(seen[1]?.key)
  })
})
