import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../signed-in.ts'

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

function transcript(messages: Message[], state = 'idle') {
  return [
    signedIn(),
    http.get('*/spaces/acme/conversations/c-1', () =>
      HttpResponse.json({
        id: 'c-1',
        agentKind: 'claude-code',
        machineName: 'mina-mbp',
        working: { state },
        messages,
      }),
    ),
  ]
}

const AT = '2026-08-26T10:00:00.000Z'
const say = (seq: number, role: string, content: unknown): Message => ({
  seq,
  role,
  content,
  at: AT,
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

  it('will not take a second question while the first is unanswered', async () => {
    server.use(...transcript([say(1, 'user', { text: 'take your time' })], 'working'))

    open('/s/acme/c/c-1')

    expect(await screen.findByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
  })

  it('says its machine is not here rather than pretending it is thinking', async () => {
    server.use(...transcript([say(1, 'user', { text: 'hello' })], 'unknown'))

    open('/s/acme/c/c-1')

    expect(await screen.findByText(/machine is not here/i)).toBeDefined()
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

describe('saying something', () => {
  it('tells the two refusals apart, because they are not the same wait', async () => {
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
