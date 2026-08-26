import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../pretend/signed-in.ts'
import { isWatching, serverSends } from '../../pretend/event-source.ts'
import type { components } from '../../generated/api.ts'

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
  sessionStorage.clear()
})
afterAll(() => {
  server.close()
})

function open(at: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [at] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

type Message = { seq: number; role: string; content: unknown; at: string }

/**
 * A conversation the server hands over, tail and all.
 *
 * `after` is honoured rather than ignored, because the page joins what comes back onto what it
 * already has: a handler that answered every ask with the whole thing would put every message on
 * screen once more per ask, and the tests would be measuring that instead of the page.
 *
 * The array is read when it is asked for, so a test can add to it and then say so.
 */
function transcript(
  messages: Message[],
  state = 'idle',
  offers: Offers = [],
  underway?: Transcript['underway'],
) {
  return [
    signedIn(),
    http.get('*/spaces/acme/conversations/c-1', ({ request }) => {
      const after = new URL(request.url).searchParams.get('after')
      const tail = after === null ? messages : messages.filter((one) => one.seq > Number(after))

      return HttpResponse.json<Transcript>({
        id: 'c-1',
        agentKind: 'claude-code',
        machineName: 'mina-mbp',
        working: { state } as Transcript['working'],
        offers,
        messages: tail as Transcript['messages'],
        ...(underway === undefined ? {} : { underway }),
      })
    }),
  ]
}

/** A piece of work underway, with nothing handed out and nothing written unless a test says so. */
function underway(more: Partial<NonNullable<Transcript['underway']>> = {}) {
  return {
    goal: 'Make the hard-coded 30s timeout configurable',
    state: 'working' as const,
    sleepUntil: null,
    handedOff: [],
    outputs: [],
    under: null,
    ...more,
  }
}

type Transcript = components['schemas']['Transcript']
type Offers = Transcript['offers']

const AT = '2026-08-26T10:00:00.000Z'
const say = (seq: number, role: string, content: unknown): Message => ({
  seq,
  role,
  content,
  at: AT,
})

const OFFERS: Offers = [
  {
    id: 'default',
    name: 'Default',
    about: 'Whatever it would pick',
    efforts: [],
    isDefault: true,
  },
  {
    id: 'opus-5',
    name: 'Opus 5',
    about: 'The slow careful one',
    efforts: ['low', 'high'],
    isDefault: false,
  },
]

describe('reading a conversation again while it works', () => {
  it('asks only for what it does not have, and shows both halves as one', async () => {
    // A transcript is only appended to, so what is on screen can never be revised. Asked for
    // whole every second — which is how often this page asks while an agent works — somebody
    // watching an hour of work downloads that hour back to themselves thousands of times.
    const asked: (string | null)[] = []
    server.use(
      signedIn(),
      http.get('*/spaces/acme/conversations/c-1', ({ request }) => {
        const after = new URL(request.url).searchParams.get('after')
        asked.push(after)

        return HttpResponse.json<Transcript>({
          id: 'c-1',
          agentKind: 'claude-code',
          machineName: 'mina-mbp',
          working: { state: 'working' } as Transcript['working'],
          offers: [],
          messages: (after === null
            ? [say(1, 'user', { text: 'read notes.txt' })]
            : [
                say(2, 'assistant', { text: 'The timeout is 30 seconds.' }),
              ]) as Transcript['messages'],
        })
      }),
    )

    open('/s/acme/c/c-1')

    // Past the one-second refetch, which is the whole subject: the second ask is the one that
    // carries `after`.
    expect(
      await screen.findByText('The timeout is 30 seconds.', {}, { timeout: 4000 }),
    ).toBeDefined()
    // The first line is still there, and it was never sent twice.
    expect(screen.getByText('read notes.txt')).toBeDefined()
    expect(asked[0]).toBeNull()
    expect(asked[1]).toBe('1')
  })
})

describe('reading a conversation', () => {
  it('shows what was said, in order', async () => {
    server.use(
      ...transcript([
        say(1, 'user', { text: 'read notes.txt' }),
        say(2, 'assistant', { text: 'The timeout is 30 seconds.' }),
      ]),
    )

    open('/s/acme/c/c-1')

    expect(await screen.findByText('read notes.txt')).toBeDefined()
    expect(await screen.findByText('The timeout is 30 seconds.')).toBeDefined()
  })

  it('shows what it did, not only what it said', async () => {
    server.use(
      ...transcript([
        say(1, 'tool', { name: 'Bash', verb: 'ran', arg: 'cat notes.txt', ok: true, excerpt: 'x' }),
      ]),
    )

    open('/s/acme/c/c-1')

    expect(await screen.findByText('ran')).toBeDefined()
    expect(await screen.findByText('cat notes.txt')).toBeDefined()
  })

  it('shows a tool it has no word for by the name the agent gave it', async () => {
    // The set of tools is open. A page that could only show the ones it was taught would go blind
    // the first time somebody connected an MCP server.
    server.use(
      ...transcript([
        say(1, 'tool', { name: 'mcp__linear__create_issue', verb: '', arg: '', excerpt: '' }),
      ]),
    )

    open('/s/acme/c/c-1')

    expect(await screen.findByText('mcp__linear__create_issue')).toBeDefined()
  })

  it('says out loud that it did not remember what came before', async () => {
    server.use(...transcript([say(1, 'activity', { activityType: 'forgot' })]))

    open('/s/acme/c/c-1')

    expect(await screen.findByText(/does not remember/i)).toBeDefined()
  })

  it('says that nobody knows how a turn went, rather than showing nothing', async () => {
    server.use(...transcript([say(1, 'activity', { activityType: 'unknown' })]))

    open('/s/acme/c/c-1')

    expect(await screen.findByText(/nobody knows/i)).toBeDefined()
  })

  it('shows an activity it has never heard of as itself', async () => {
    // New kinds arrive as values, not releases. Dropping the ones this build does not know would
    // leave a conversation looking like it skipped something.
    server.use(...transcript([say(1, 'activity', { activityType: 'some-future-thing' })]))

    open('/s/acme/c/c-1')

    expect(await screen.findByText('some-future-thing')).toBeDefined()
  })

  it('shows nothing for a turn that simply ended', async () => {
    server.use(
      ...transcript([
        say(1, 'assistant', { text: 'done and dusted' }),
        say(2, 'activity', { activityType: 'done' }),
      ]),
    )

    open('/s/acme/c/c-1')

    await screen.findByText('done and dusted')
    expect(screen.queryByText('done')).toBeNull()
  })

  it('says the same thing about a conversation that is not there as about one that is not yours', async () => {
    server.use(
      signedIn(),
      http.get('*/spaces/acme/conversations/c-1', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'start-over' }, { status: 404 }),
      ),
    )

    open('/s/acme/c/c-1')

    expect(await screen.findByText('This conversation is not available')).toBeDefined()
  })
})

describe('watching it work', () => {
  const LIVE = '/spaces/acme/conversations/c-1/live'
  const working = () => transcript([say(1, 'user', { text: 'take your time' })], 'working')

  it('shows what it is thinking, which the transcript never keeps', async () => {
    server.use(...working())
    open('/s/acme/c/c-1')
    await screen.findByRole('button', { name: 'Stop' })

    serverSends(LIVE, {
      seen: 'moment',
      moment: { said: 'thinking', text: 'let me look at the file' },
    })

    expect(await screen.findByText(/let me look at the file/i)).toBeDefined()
  })

  it('shows that it has started something, before there is anything to say about it', async () => {
    server.use(...working())
    open('/s/acme/c/c-1')
    await screen.findByRole('button', { name: 'Stop' })

    serverSends(LIVE, {
      seen: 'moment',
      moment: { said: 'doing', name: 'Bash', verb: 'ran', arg: 'rg timeout src/' },
    })

    expect(await screen.findByText(/ran rg timeout src\//i)).toBeDefined()
  })

  it('still says it is thinking when the agent keeps no readable thought', async () => {
    // Claude Code's own record keeps a signature and no text. "It is thinking" is all there is to
    // say, and a line reading "Thinking —" with nothing after it says less than nothing.
    server.use(...working())
    open('/s/acme/c/c-1')
    await screen.findByRole('button', { name: 'Stop' })

    serverSends(LIVE, { seen: 'moment', moment: { said: 'thinking', text: '' } })

    expect(await screen.findByText('Thinking…')).toBeDefined()
  })

  it('says out loud that the thinking is not kept', async () => {
    // The difference between watching and coming back, said before somebody discovers it by
    // looking for something that is gone.
    server.use(...working())
    open('/s/acme/c/c-1')
    await screen.findByRole('button', { name: 'Stop' })

    serverSends(LIVE, { seen: 'moment', moment: { said: 'thinking', text: 'hm' } })

    expect(await screen.findByText(/never kept/i)).toBeDefined()
  })

  it('reads the transcript when the stream says it has grown, rather than on a clock', async () => {
    // The stream carries that there is something new, never the something. So this is the whole
    // of how a person sees what the agent said: told, then read. On a clock it would be however
    // long that clock is late by, every time.
    const sofar = [say(1, 'user', { text: 'take your time' })]
    server.use(...transcript(sofar, 'working'))
    open('/s/acme/c/c-1')
    await screen.findByRole('button', { name: 'Stop' })

    sofar.push(say(2, 'assistant', { text: 'the timeout is 30 seconds' }))
    serverSends(LIVE, { seen: 'written', upTo: 2 })

    expect(await screen.findByText('the timeout is 30 seconds')).toBeDefined()
  })

  it('shows what it said once, in the transcript, and not twice', async () => {
    // What is written down is never also pushed down the stream. Sent both ways it would arrive
    // twice — under "Happening now" and again in the transcript — and in two orders whenever a
    // write had to be retried.
    server.use(
      ...transcript(
        [
          say(1, 'user', { text: 'take your time' }),
          say(2, 'assistant', { text: 'the timeout is 30 seconds' }),
        ],
        'working',
      ),
    )
    open('/s/acme/c/c-1')
    await screen.findByText('the timeout is 30 seconds')

    serverSends(LIVE, { seen: 'moment', moment: { said: 'thinking', text: 'hm' } })
    await screen.findByText(/hm/i)

    expect(screen.queryAllByText('the timeout is 30 seconds')).toHaveLength(1)
  })

  it('watches nothing at all once the turn has settled', async () => {
    // A connection held open on a finished conversation is one held open for nothing.
    server.use(...transcript([say(1, 'activity', { activityType: 'done' })]))
    open('/s/acme/c/c-1')
    await screen.findByRole('button', { name: 'Send' })

    expect(isWatching(LIVE)).toBe(false)
  })
})

describe('while it is working', () => {
  it('offers a way to stop it, and takes it away once it is idle', async () => {
    server.use(...transcript([say(1, 'user', { text: 'take your time' })], 'working'))

    open('/s/acme/c/c-1')

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeDefined()
  })

  it('asks to stop the turn by name, so asking twice is one request and not two', async () => {
    // The server keeps a request under the name it is given. A fresh name per click would put a
    // second "you asked it to stop" in the transcript of a turn somebody asked about once.
    const asked: string[] = []
    server.use(
      ...transcript([say(4, 'user', { text: 'take your time' })], 'working'),
      http.post('*/spaces/acme/conversations/c-1/stop', async ({ request }) => {
        const body = (await request.json()) as { key: string }
        asked.push(body.key)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    open('/s/acme/c/c-1')
    const stop = await screen.findByRole('button', { name: 'Stop' })
    await userEvent.click(stop)
    await userEvent.click(stop)

    expect(asked).toEqual(['4/stop', '4/stop'])
  })

  it('has no way to stop something that is not running', async () => {
    server.use(...transcript([say(1, 'activity', { activityType: 'done' })]))

    open('/s/acme/c/c-1')

    await screen.findByRole('button', { name: 'Send' })
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('lets somebody type while it works, and offers Stop where Send would be', async () => {
    // Whoever types "no, leave legacy/ alone" is typing it *because* it is busy. A field that
    // greys itself out at that moment is grey for the one moment it had a job to do — and a Send
    // that ended the turn would make typing itself risky.
    server.use(...transcript([say(1, 'user', { text: 'take your time' })], 'working'))

    open('/s/acme/c/c-1')

    expect(await screen.findByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByLabelText('Say something')).toHaveProperty('disabled', false)
  })

  it('says its machine is not here rather than pretending it is thinking', async () => {
    server.use(...transcript([say(1, 'user', { text: 'hello' })], 'unknown'))

    open('/s/acme/c/c-1')

    expect(await screen.findByText(/machine is not here/i)).toBeDefined()
  })

  it('sends a changed choice as a new message, not as the same one again', async () => {
    // The first attempt landed and the answer was lost; the person changes the model and presses
    // Send again. Named by the words alone, the server would call it a repeat and the choice they
    // just made would be thrown away.
    const names: string[] = []
    server.use(
      ...transcript([say(1, 'activity', { activityType: 'done' })], 'idle', OFFERS),
      http.post('*/spaces/acme/conversations/c-1/messages', async ({ request }) => {
        names.push(((await request.json()) as { key: string }).key)
        return HttpResponse.json(
          { reason: 'unavailable', recovery: 'retry-later' },
          { status: 503 },
        )
      }),
    )

    open('/s/acme/c/c-1')
    await userEvent.type(await screen.findByLabelText('Say something'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      expect(names).toHaveLength(1)
    })

    await userEvent.selectOptions(screen.getByLabelText('Model'), 'opus-5')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(names).toHaveLength(2)
    })
    expect(names[0]).not.toBe(names[1])
  })

  it('sends the same words under the same name, so a lost answer is not two messages', async () => {
    // The one case the name exists for: the message landed and the answer did not come back, so
    // somebody presses Send again on words that are already in there.
    const names: string[] = []
    let refuse = true
    server.use(
      ...transcript([say(1, 'activity', { activityType: 'done' })]),
      http.post('*/spaces/acme/conversations/c-1/messages', async ({ request }) => {
        const body = (await request.json()) as { key: string }
        names.push(body.key)
        if (!refuse) return new HttpResponse(null, { status: 204 })
        refuse = false
        return HttpResponse.json(
          { reason: 'unavailable', recovery: 'retry-later' },
          { status: 503 },
        )
      }),
    )

    open('/s/acme/c/c-1')
    await userEvent.type(await screen.findByLabelText('Say something'), 'hello')
    const send = screen.getByRole('button', { name: 'Send' })
    await userEvent.click(send)
    await userEvent.click(send)

    expect(names).toHaveLength(2)
    expect(names[0]).toBe(names[1])
  })
})

describe('choosing what to ask with', () => {
  it('has no control at all when the agent offers no choice', async () => {
    // Picking an agent is picking what it can do. An empty select would be a question with no
    // answers, and this also covers an agent nobody has asked yet.
    server.use(...transcript([say(1, 'activity', { activityType: 'done' })]))

    open('/s/acme/c/c-1')
    await screen.findByLabelText('Say something')

    expect(screen.queryByLabelText('Model')).toBeNull()
  })

  it('names the agent-s own default rather than listing it twice', async () => {
    // Claude Code publishes its default as a row of its own. An "its default" option beside a row
    // called "Default" is two ways to say one thing, and one of them would look like the pinned
    // choice it is not.
    server.use(...transcript([say(1, 'activity', { activityType: 'done' })], 'idle', OFFERS))

    open('/s/acme/c/c-1')
    const models = (await screen.findByLabelText('Model')) as HTMLSelectElement

    expect([...models.options].map((one) => one.text)).toEqual(['Default', 'Opus 5'])
    // Choosing it sends nothing at all, so the agent is never pinned to today's default.
    expect(models.options[0]?.value).toBe('')
  })

  it('sends nothing when nothing was chosen, so the agent stays on its own default', async () => {
    // We never pick one on its behalf. A default we invented would be a choice nobody made,
    // attributed to the agent.
    let asked: unknown
    server.use(
      ...transcript([say(1, 'activity', { activityType: 'done' })], 'idle', OFFERS),
      http.post('*/spaces/acme/conversations/c-1/messages', async ({ request }) => {
        asked = ((await request.json()) as { asked: unknown }).asked
        return new HttpResponse(null, { status: 204 })
      }),
    )

    open('/s/acme/c/c-1')
    await userEvent.type(await screen.findByLabelText('Say something'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(asked).toEqual({ text: 'hello' })
    })
  })

  it('sends the model and the effort that were chosen', async () => {
    let asked: unknown
    server.use(
      ...transcript([say(1, 'activity', { activityType: 'done' })], 'idle', OFFERS),
      http.post('*/spaces/acme/conversations/c-1/messages', async ({ request }) => {
        asked = ((await request.json()) as { asked: unknown }).asked
        return new HttpResponse(null, { status: 204 })
      }),
    )

    open('/s/acme/c/c-1')
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'opus-5')
    await userEvent.selectOptions(screen.getByLabelText('Thinking'), 'high')
    await userEvent.type(screen.getByLabelText('Say something'), 'think hard')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(asked).toEqual({ text: 'think hard', model: 'opus-5', effort: 'high' })
    })
  })

  it('has no thinking control for a model that has no such setting', async () => {
    server.use(...transcript([say(1, 'activity', { activityType: 'done' })], 'idle', OFFERS))

    open('/s/acme/c/c-1')
    await screen.findByLabelText('Model')

    // The default-marked one has none, and it is what the levels belong to until somebody chooses.
    expect(screen.queryByLabelText('Thinking')).toBeNull()
  })

  it('drops an effort the newly chosen model does not have', async () => {
    // Not a choice any more, just a leftover — and one the agent would be asked to honour.
    server.use(...transcript([say(1, 'activity', { activityType: 'done' })], 'idle', OFFERS))

    open('/s/acme/c/c-1')
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'opus-5')
    await userEvent.selectOptions(screen.getByLabelText('Thinking'), 'high')

    // Back to the default, whose value is empty because choosing it sends nothing.
    await userEvent.selectOptions(screen.getByLabelText('Model'), '')

    expect(screen.queryByLabelText('Thinking')).toBeNull()
  })
})

describe('saying something', () => {
  it('says so when the machine is not there to hear it', async () => {
    server.use(
      ...transcript([say(1, 'activity', { activityType: 'done' })]),
      http.post('*/spaces/acme/conversations/c-1/messages', () =>
        HttpResponse.json(
          { reason: 'machine-away', recovery: 'choose-another-machine' },
          { status: 409 },
        ),
      ),
    )

    open('/s/acme/c/c-1')
    await userEvent.type(await screen.findByLabelText('Say something'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(/machine is not here/i)).toBeDefined()
  })
})

describe('handing a conversation over', () => {
  it('asks the agent for the sentence, because it has never heard of a piece of work', async () => {
    // An agent in an ordinary conversation answers questions. Somebody typing "take it from here"
    // is talking to something that has no idea what that means — so this asks it in words it will
    // act on, and what comes back is its own restatement.
    const sent: { asked: { text: string } }[] = []
    server.use(
      ...transcript([say(1, 'user', { text: 'where does the timeout live?' })]),
      http.post('*/spaces/acme/conversations/c-1/messages', async ({ request }) => {
        sent.push((await request.json()) as { asked: { text: string } })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/s/acme/c/c-1')

    await userEvent.click(await screen.findByRole('button', { name: 'Hand it over…' }))

    await waitFor(() => {
      expect(sent[0]?.asked.text).toContain('handover task new')
    })
  })

  it('offers no such thing once it has been handed over', async () => {
    server.use(...transcript([say(1, 'user', { text: 'go' })], 'idle', [], underway()))

    open('/s/acme/c/c-1')

    await screen.findByLabelText('This piece of work')
    expect(screen.queryByRole('button', { name: 'Hand it over…' })).toBeNull()
  })

  it('shows what the agent says it will do, with a way to agree to it', async () => {
    // Not an approval step — a restatement. What is being confirmed is that it understood, which
    // is the one thing ten seconds here buys and three hours in the morning does not.
    server.use(
      ...transcript([
        say(1, 'user', { text: 'take it from here' }),
        say(2, 'activity', { activityType: 'proposed', text: 'Make the timeout configurable' }),
      ]),
    )

    open('/s/acme/c/c-1')

    expect(await screen.findByText('Make the timeout configurable')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Hand it over' })).toBeDefined()
  })

  it('hands over the sentence the agent wrote, not anything the person typed', async () => {
    const sent: { goal: string }[] = []
    server.use(
      ...transcript([
        say(2, 'activity', { activityType: 'proposed', text: 'Make the timeout configurable' }),
      ]),
      http.post('*/spaces/acme/conversations/c-1/task', async ({ request }) => {
        sent.push((await request.json()) as { goal: string })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/s/acme/c/c-1')

    await userEvent.click(await screen.findByRole('button', { name: 'Hand it over' }))

    await waitFor(() => {
      expect(sent).toMatchObject([{ goal: 'Make the timeout configurable' }])
    })
  })

  it('shows nothing about a piece of work in a conversation nobody handed over', async () => {
    server.use(...transcript([say(1, 'user', { text: 'where does the timeout live?' })]))

    open('/s/acme/c/c-1')

    await screen.findByRole('button', { name: 'Send' })
    expect(screen.queryByLabelText('This piece of work')).toBeNull()
  })
})

describe('what a piece of work shows beside the conversation', () => {
  it('keeps the goal and where it has got to out of the transcript', async () => {
    // Two hundred lines in, the line that mattered is somewhere above. None of this may be
    // something a person has to scroll for.
    server.use(...transcript([say(1, 'user', { text: 'go' })], 'working', [], underway()))

    open('/s/acme/c/c-1')

    const rail = await screen.findByLabelText('This piece of work')
    expect(rail.textContent).toContain('Make the hard-coded 30s timeout configurable')
    expect(rail.textContent).toContain('Working')
  })

  it('says it is waiting on what it handed out, which is counted and not stored', async () => {
    server.use(
      ...transcript(
        [say(1, 'user', { text: 'go' })],
        'idle',
        [],
        underway({
          handedOff: [
            {
              conversationId: 'c-2',
              goal: 'Add an integration test',
              state: 'working',
              machineName: 'build-server-1',
              agentKind: 'codex',
            },
          ],
        }),
      ),
    )

    open('/s/acme/c/c-1')

    const rail = await screen.findByLabelText('This piece of work')
    expect(rail.textContent).toContain('Waiting on 1 it handed out')
    expect(within(rail).getByRole('link', { name: 'Add an integration test' })).toBeDefined()
  })

  it('says when it will wake by itself', async () => {
    server.use(
      ...transcript(
        [say(1, 'user', { text: 'go' })],
        'idle',
        [],
        underway({ state: 'sleep', sleepUntil: '2030-09-03T12:00:00.000Z' }),
      ),
    )

    open('/s/acme/c/c-1')

    expect((await screen.findByLabelText('This piece of work')).textContent).toContain(
      'Asleep until',
    )
  })

  it('lists what has happened, built from the transcript and asking the agent for nothing', async () => {
    server.use(
      ...transcript(
        [
          say(1, 'user', { text: 'go' }),
          say(2, 'activity', { activityType: 'handed-over', text: 'the goal' }),
          say(3, 'activity', { activityType: 'asked', text: 'A or B?' }),
        ],
        'idle',
        [],
        underway({ state: 'wait' }),
      ),
    )

    open('/s/acme/c/c-1')

    const rail = await screen.findByLabelText('This piece of work')
    expect(rail.textContent).toContain('You handed it over')
    expect(rail.textContent).toContain('It asked you something')
  })

  it('opens what it wrote where it is, rather than on a page of its own', async () => {
    server.use(
      ...transcript(
        [say(1, 'user', { text: 'go' })],
        'idle',
        [],
        underway({
          outputs: [
            {
              title: 'Rollout review',
              body: 'Error rate flat at 0.02%.',
              writtenAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        }),
      ),
    )
    open('/s/acme/c/c-1')

    await userEvent.click(await screen.findByRole('button', { name: 'Rollout review' }))

    expect(screen.getByText('Error rate flat at 0.02%.')).toBeDefined()
  })

  it('takes it back, and says that takes back what it handed out too', async () => {
    let asked = false
    server.use(
      ...transcript([say(1, 'user', { text: 'go' })], 'idle', [], underway()),
      http.delete('*/spaces/acme/conversations/c-1/task', () => {
        asked = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/s/acme/c/c-1')

    await userEvent.click(await screen.findByRole('button', { name: 'Take it back' }))

    await waitFor(() => {
      expect(asked).toBe(true)
    })
  })
})
