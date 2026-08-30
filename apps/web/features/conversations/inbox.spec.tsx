/**
 * The only brake this product has.
 *
 * There is no budget and no ceiling on a piece of work somebody handed over — what stops one is a
 * person. So the failure worth testing for is not a wrong number: it is a row that should be here
 * and is not, because that is a piece of work nobody will ever come back to.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../../generated/api.ts'
import { theSpace } from '../../pretend/a-space.ts'
import { routeTree } from '../../routeTree.gen.ts'

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

type Waiting = components['schemas']['Waiting']

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ['/s/acme'] }),
  })
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await userEvent.click(await screen.findByRole('button', { name: 'Inbox' }))
  return { router, view }
}

/**
 * The Inbox as it is actually met: a tab in the sidebar of whichever Space somebody is in.
 *
 * It is not a Space's — the rows cross all of them — and it is reachable from every one of them
 * for exactly that reason: what must never be hard to find is found from wherever you are.
 */
function waiting(rows: Waiting[]) {
  return [...theSpace(), http.get('*/me/inbox', () => HttpResponse.json({ waiting: rows }))]
}

const ONE: Waiting = {
  conversationId: 'c-1',
  spaceSlug: 'acme',
  machineName: 'mina-mbp',
  goal: 'Make the hard-coded 30s timeout configurable',
  asked: 'Env var, or a field on the client options?',
  since: '2026-09-01T00:00:00.000Z',
}

describe('what is waiting on you', () => {
  it('shows the goal and what it asked, so nobody has to open it to find out', async () => {
    server.use(...waiting([ONE]))

    const { router } = await open()

    expect(await screen.findByText(ONE.goal)).toBeDefined()
    expect(screen.getByText('Env var, or a field on the client options?')).toBeDefined()

    await userEvent.click(screen.getByRole('link', { name: new RegExp(ONE.goal, 'u') }))
    expect(router.state.location.pathname).toBe('/s/acme/c/c-1')
  })

  it('crosses Spaces, because work you handed out is yours wherever it lives', async () => {
    server.use(...waiting([ONE, { ...ONE, conversationId: 'c-2', spaceSlug: 'lab' }]))

    await open()

    expect(await screen.findByText(/acme/u)).toBeDefined()
    expect(screen.getByText(/lab/u)).toBeDefined()
  })

  it('says something when nothing needs you, rather than showing an empty list', async () => {
    server.use(...waiting([]))

    await open()

    expect(await screen.findByText(/Nothing needs you/u)).toBeDefined()
  })

  it('never says nothing needs you when it could not read', async () => {
    // The one thing this page must not do. "Nothing needs you" is somebody being told they can go
    // to bed, and a failed read is not that.
    server.use(
      ...theSpace(),
      http.get('*/me/inbox', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'retry-later' }, { status: 500 }),
      ),
    )

    await open()

    expect(await screen.findByText(/Could not read your Inbox/u)).toBeDefined()
    expect(screen.queryByText(/Nothing needs you/u)).toBeNull()
  })

  it('says so when a piece of work stopped without saying why', async () => {
    server.use(...waiting([{ ...ONE, asked: null }]))

    await open()

    expect(await screen.findByText(/stopped without saying why/u)).toBeDefined()
  })
})
