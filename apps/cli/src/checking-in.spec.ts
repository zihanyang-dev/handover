import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'
import { apiFor } from './api.ts'
import { keepCheckingIn, reportOnce, stopIfAsked } from './checking-in.ts'
import { VERSION } from './env.ts'

/**
 * A real command on a real PATH, so what the loop went looking for is visible in what it reports.
 *
 * Without one, every report comes back empty whatever the server asked for, and a test about
 * following the server's list can only count the reports — which is a test that passes with the
 * following taken out.
 */
let BIN = ''

beforeAll(async () => {
  BIN = await mkdtemp(join(tmpdir(), 'handover-checking-in-'))
  const path = join(BIN, 'some-new-agent')
  await writeFile(path, '#!/bin/sh\necho 1.2.3\n')
  await chmod(path, 0o755)
})

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

/** Stops after a fixed number of check-ins: what is under test is the loop, not the clock. */
function runningFor(rounds: number) {
  const said: string[] = []
  /** How long the loop asked to wait each round, which is how it paces itself. */
  const waited: number[] = []
  const stopping = new AbortController()
  let left = rounds

  return {
    said,
    waited,
    signal: stopping.signal,
    running: {
      env: { PATH: '/nonexistent' } as NodeJS.ProcessEnv,
      where: '/nowhere',
      handover: 'handover',
      say: (line: string) => said.push(line),
      sleep: async (seconds: number) => {
        waited.push(seconds)
        left -= 1
        if (left <= 0) stopping.abort()
      },
    },
  }
}

function keepsAnswering(reports: unknown[] = [], lookFor: string[] = []) {
  return http.post(`${ORIGIN}/machines/current/poll`, async ({ request }) => {
    reports.push(await request.json())
    return HttpResponse.json({ pollSeconds: 25, lookFor })
  })
}

describe('staying connected', () => {
  it('reports what it found, every time', async () => {
    const reports: unknown[] = []
    server.use(keepsAnswering(reports))
    const { running, signal } = runningFor(3)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(reports).toHaveLength(3)
  })

  it('says which build it is, in every report and not only the first', async () => {
    // Every report, because the binary can be replaced between two of them — somebody re-running
    // the installer on a machine that never stops running. A version said once at connect would
    // name the build that is gone.
    const reports: unknown[] = []
    server.use(keepsAnswering(reports))
    const { running, signal } = runningFor(2)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(reports).toEqual([
      expect.objectContaining({ version: VERSION }),
      expect.objectContaining({ version: VERSION }),
    ])
  })

  it('follows the list the server tells it, without being restarted', async () => {
    // The deployment decides what it knows how to run. A machine carrying its own list would
    // report agents the server drops, or hide ones it could have used.
    const reports: { found: unknown[] }[] = []
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, async ({ request }) => {
        reports.push((await request.json()) as { found: unknown[] })
        return HttpResponse.json({ pollSeconds: 25, lookFor: ['some-new-agent'] })
      }),
    )
    const { running, signal } = runningFor(2)
    running.env = { PATH: BIN }

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    // It started knowing nothing, and by the second report it was looking for a command nobody
    // compiled into it — which is the whole of what the list being the server's means.
    expect(reports[0]?.found).toEqual([])
    // `models: []` because this machine has no adapter for that command — it went looking, and
    // there was nothing to ask.
    expect(reports[1]?.found).toEqual([{ command: 'some-new-agent', version: '1.2.3', models: [] }])
  })

  it('says it has just started, once, so what it left open can be closed', async () => {
    // Only this machine can say it restarted, and it is worth saying: a turn left open on a
    // machine that has just started is one whose agent went on working with nobody watching.
    const reports: { restarted?: boolean }[] = []
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, async ({ request }) => {
        reports.push((await request.json()) as { restarted?: boolean })
        return HttpResponse.json({ pollSeconds: 25, lookFor: [] })
      }),
    )
    const { running, signal } = runningFor(3)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(reports.map((one) => one.restarted)).toEqual([true, false, false])
  })

  it('keeps saying it restarted until a report actually arrives', async () => {
    // Only this machine can say it restarted, and a report nobody received said nothing. Dropping
    // it there would leave whatever it left open working forever.
    const reports: { restarted?: boolean }[] = []
    let asked = 0
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, async ({ request }) => {
        asked += 1
        if (asked < 3) return HttpResponse.error()
        reports.push((await request.json()) as { restarted?: boolean })
        return HttpResponse.json({ pollSeconds: 25, lookFor: [] })
      }),
    )
    const { running, signal } = runningFor(4)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(reports[0]?.restarted).toBe(true)
  })

  it('stops for good once the machine has been taken away', async () => {
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () =>
        HttpResponse.json({ reason: 'no-machine', recovery: 'start-over' }, { status: 401 }),
      ),
    )
    const { running, signal } = runningFor(5)

    const stopped = await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(stopped).toEqual({ kind: 'removed' })
  })

  it('stops the agent it was running before it goes, rather than leaving an orphan', async () => {
    // A machine taken out of its Space exits for good. The agent it was driving is a separate
    // process: left alone it goes on changing files in somebody's project with nobody watching.
    let stopped = false
    let asked = 0
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () => {
        return HttpResponse.json(
          {
            pollSeconds: 25,
            lookFor: [],
            asking: {
              conversationId: 'c-1',
              agentKind: 'claude-code',
              agentSession: null,
              afterSeq: 1,
              asked: { text: 'take your time' },
            },
          },
          { status: asked++ === 0 ? 200 : 401 },
        )
      }),
      http.post(`${ORIGIN}/machines/current/conversations/:id/messages`, () => {
        stopped = true
        return new HttpResponse(null, { status: 204 })
      }),
      http.post(
        `${ORIGIN}/machines/current/conversations/:id/live`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    )
    const { running, signal } = runningFor(3)

    const over = await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(over).toEqual({ kind: 'removed' })
    // Whatever the turn ended as, it ended: the record was closed before this process left.
    expect(stopped).toBe(true)
  })

  it('waits for a stopped turn to end rather than asking again as fast as it can', async () => {
    // A stop is the one thing the server answers at once instead of holding, and it goes on
    // answering it until the turn ends. Asking again straight away is one request per round trip
    // for as long as the agent takes to wind down — which, on an agent that does not go quietly,
    // is thousands of them.
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () =>
        HttpResponse.json({
          pollSeconds: 0,
          lookFor: [],
          asking: {
            conversationId: 'c-1',
            agentKind: 'claude-code',
            agentSession: null,
            afterSeq: 1,
            asked: { text: 'take your time' },
          },
          stopping: { conversationId: 'c-1', afterSeq: 1 },
        }),
      ),
      // The turn never ends: this machine cannot run that agent, and saying so never gets through.
      http.post(`${ORIGIN}/machines/current/conversations/:id/messages`, () =>
        HttpResponse.error(),
      ),
    )
    const { running, signal, waited } = runningFor(4)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    // Every round after the one that took the turn waits, rather than coming straight back round.
    expect(waited.slice(1).every((seconds) => seconds > 0)).toBe(true)
  })

  it('keeps trying through a server that is gone, and says so once it is back', async () => {
    let asked = 0
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () => {
        asked += 1
        if (asked < 3) return HttpResponse.error()
        return HttpResponse.json({ pollSeconds: 25, lookFor: [] })
      }),
    )
    const { running, signal, said } = runningFor(4)

    const stopped = await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(stopped).toEqual({ kind: 'asked-to-stop' })
    expect(said.filter((line) => line.includes('cannot reach'))).toHaveLength(2)
  })

  it('stops when it is asked to', async () => {
    server.use(keepsAnswering())
    const { running, signal } = runningFor(1)

    expect(await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)).toEqual({
      kind: 'asked-to-stop',
    })
  })
})

describe('being asked to stop', () => {
  it('stops without waiting out the sleep it is in, or the goodbye comes too late', async () => {
    // Stopping a service is a SIGTERM and then a kill a few seconds later. Noticing only when a
    // twenty-five second sleep ends means being killed first, and the Space showing a machine
    // that is gone as here for another minute.
    server.use(keepsAnswering())
    const stopping = new AbortController()
    const running = {
      env: {},
      where: '/nowhere',
      handover: 'handover',
      say: () => undefined,
      sleep: async (seconds: number, until: AbortSignal) =>
        new Promise<void>((wake) => {
          const timer = setTimeout(wake, seconds * 1000)
          until.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              wake()
            },
            { once: true },
          )
        }),
    }

    const stopped = keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, stopping.signal)
    await new Promise((wake) => setTimeout(wake, 50))
    stopping.abort()

    expect(await stopped).toEqual({ kind: 'asked-to-stop' })
  })
})

describe('one report, and what came of it', () => {
  const env = { PATH: '/nonexistent' }

  it('is here when the server took it', async () => {
    server.use(keepsAnswering([], ['claude']))

    expect(await reportOnce(apiFor(ORIGIN, 'hm_t'), [], env)).toMatchObject({
      said: 'here',
      lookFor: ['claude'],
      pollSeconds: 25,
    })
  })

  it('is not ours when the credential is not one the server knows', async () => {
    // What being taken out of a Space looks like from here. It is also what `connect` asks when
    // it finds an attachment on disk: a file is not a connection.
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () =>
        HttpResponse.json({ reason: 'no-machine', recovery: 'start-over' }, { status: 401 }),
      ),
    )

    expect(await reportOnce(apiFor(ORIGIN, 'hm_t'), [], env)).toEqual({ said: 'not-ours' })
  })

  it('is unreachable when nothing answered, which is not the same as being turned away', async () => {
    // Folding this into `not-ours` would throw away a working credential over a dropped Wi-Fi,
    // and send somebody to enrol a machine that was never removed.
    server.use(http.post(`${ORIGIN}/machines/current/poll`, () => HttpResponse.error()))

    expect(await reportOnce(apiFor(ORIGIN, 'hm_t'), [], env)).toMatchObject({
      said: 'unreachable',
    })
  })
})

describe('acting on a stop', () => {
  const TURN = { conversationId: 'c-1', afterSeq: 20 }

  /** An agent that remembers whether anybody stopped it. */
  function answering(conversationId: string, afterSeq: number) {
    let stopped = false

    return {
      was: () => stopped,
      it: {
        conversationId,
        afterSeq,
        done: Promise.resolve(),
        stop: async () => {
          stopped = true
        },
      },
    }
  }

  it('stops the turn the stop names', async () => {
    const agent = answering('c-1', 20)

    await stopIfAsked(agent.it, TURN, () => undefined)

    expect(agent.was()).toBe(true)
  })

  it('leaves another conversation alone', async () => {
    const agent = answering('c-2', 20)

    await stopIfAsked(agent.it, TURN, () => undefined)

    expect(agent.was()).toBe(false)
  })

  it('leaves the turn that the stop made room for alone', async () => {
    // The one that cost a person their answer. Somebody interrupts turn 20 to ask something else;
    // turn 20 ends, the machine takes the new question as turn 22, and a stop about turn 20 read
    // a moment earlier arrives. Matched by conversation alone it stops turn 22 — the very answer
    // they interrupted to get — and leaves it claimed with nobody running it.
    const agent = answering('c-1', 22)

    await stopIfAsked(agent.it, TURN, () => undefined)

    expect(agent.was()).toBe(false)
  })
})
