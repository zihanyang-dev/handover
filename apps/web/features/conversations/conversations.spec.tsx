import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { theSpace } from '../../pretend/a-space.ts'
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

const HERE = { state: 'here' } as const
const AWAY = { state: 'gone', since: new Date(Date.now() - 1_770_000).toISOString() } as const

const MINA: components['schemas']['Machine'] = {
  id: 'm-1',
  name: 'mina-mbp',
  presence: HERE,
  agents: [{ kind: 'claude-code', version: '2.1.4', models: [] }],
}

describe('the conversations in a Space', () => {
  it('says what was asked, not a name somebody had to invent', async () => {
    server.use(
      ...theSpace({
        machines: [MINA],
        conversations: [
          {
            id: 'c-1',
            agentKind: 'claude-code',
            machineId: 'm-1',
            machineName: 'mina-mbp',
            startedAt: new Date().toISOString(),
            opening: 'read the timeout logic',
            working: { state: 'idle' },
          },
        ],
      }),
    )

    open('/s/acme')

    expect(await screen.findByRole('link', { name: 'read the timeout logic' })).toBeDefined()
  })

  it('says how to start one when there are none', async () => {
    server.use(...theSpace({ machines: [MINA] }))

    open('/s/acme')

    expect(await screen.findByText(/pick an agent on one of your machines/i)).toBeDefined()
  })

  it('shows which one is being worked on', async () => {
    server.use(
      ...theSpace({
        machines: [MINA],
        conversations: [
          {
            id: 'c-1',
            agentKind: 'claude-code',
            machineId: 'm-1',
            machineName: 'mina-mbp',
            startedAt: new Date().toISOString(),
            opening: 'take your time',
            working: { state: 'working' },
          },
        ],
      }),
    )

    open('/s/acme')

    expect(await screen.findByText('Working')).toBeDefined()
  })
})

describe('starting one', () => {
  it('starts it from the agent on the machine you mean, and goes there', async () => {
    let asked: unknown
    server.use(
      ...theSpace({ machines: [MINA] }),
      http.post('*/spaces/acme/conversations', async ({ request }) => {
        asked = await request.json()
        return HttpResponse.json({ id: 'c-9' }, { status: 201 })
      }),
      http.get('*/spaces/acme/conversations/c-9', () =>
        HttpResponse.json<components['schemas']['Transcript']>({
          id: 'c-9',
          agentKind: 'claude-code',
          machineName: 'mina-mbp',
          working: { state: 'idle' },
          offers: [],
          messages: [],
        }),
      ),
    )

    open('/s/acme')
    await userEvent.click(await screen.findByRole('button', { name: /Claude Code 2\.1\.4/u }))

    expect(asked).toEqual({ machineId: 'm-1', agentKind: 'claude-code' })
    expect(await screen.findByLabelText('Say something')).toBeDefined()
  })

  it('will not start one on a machine that is not here', async () => {
    // Nothing would pick it up. Refusing before it is started is a conversation that never
    // existed, rather than one sitting there with a question nobody will ever see.
    server.use(...theSpace({ machines: [{ ...MINA, presence: AWAY }] }))

    open('/s/acme')
    const agent = await screen.findByRole('button', { name: /Claude Code 2\.1\.4/u })

    expect(agent as HTMLButtonElement).toHaveProperty('disabled', true)
  })
})
