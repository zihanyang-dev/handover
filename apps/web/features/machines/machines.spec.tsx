import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'

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

const HERE = { state: 'here' }

/**
 * Fresh each time, and half a minute away from where the rounding changes.
 *
 * A timestamp fixed when this file loads drifts against `Date.now()` while the test runs, and an
 * offset sitting on a minute boundary flips to the next number partway through a slow run.
 */
function goneHalfAnHourAgo() {
  return { state: 'gone', since: new Date(Date.now() - 1_770_000).toISOString() }
}

function theSpace(machines: unknown[]) {
  return [
    http.get('*/spaces/acme', () =>
      HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
    ),
    http.get('*/spaces/acme/machines', () => HttpResponse.json({ machines })),
    http.get('*/me', () => HttpResponse.json({ displayName: '', credentials: [], spaces: [] })),
  ]
}

async function panel() {
  return within(await screen.findByRole('region', { name: /machines/i }))
}

describe('the machines in a Space', () => {
  it('says agents run on your own machine before anybody wonders why nothing works', async () => {
    server.use(...theSpace([]))
    open('/s/acme')

    const machines = await panel()

    expect(await machines.findByText(/agents run on/i)).toBeDefined()
    expect(machines.getByText('handover connect')).toBeDefined()
  })

  it('shows one that is here, with what it has', async () => {
    server.use(
      ...theSpace([
        {
          id: 'm-1',
          name: 'mina-mbp',
          presence: HERE,
          agents: [{ kind: 'claude-code', version: '2.1.4' }],
        },
      ]),
    )
    open('/s/acme')

    const machines = await panel()

    expect(await machines.findByText('mina-mbp')).toBeDefined()
    expect(machines.getByText('Online')).toBeDefined()
    expect(machines.getByText(/Claude Code 2\.1\.4/u)).toBeDefined()
  })

  it('says when one was last heard from, rather than dropping it', async () => {
    // Gone is not the same as never connected. Somebody looking for a machine they set up needs
    // to see it sitting there, offline.
    server.use(
      ...theSpace([{ id: 'm-1', name: 'mina-mbp', presence: goneHalfAnHourAgo(), agents: [] }]),
    )
    open('/s/acme')

    const machines = await panel()

    const row = (await machines.findByText('mina-mbp')).closest('li')

    expect(row?.textContent).toMatch(/offline · last seen 30 minutes ago/iu)
  })

  it('says a connected machine has no agents, rather than calling it no machines', async () => {
    // Two different things to do next: install an agent, or connect a machine. Merging them sends
    // somebody to reconnect one that is already connected, while its terminal says it is online.
    server.use(...theSpace([{ id: 'm-1', name: 'mina-mbp', presence: HERE, agents: [] }]))
    open('/s/acme')

    const machines = await panel()

    expect(await machines.findByText(/no agents found on it yet/i)).toBeDefined()
    expect(machines.queryByText(/agents run on/i)).toBeNull()
  })

  it('says it could not read them, rather than saying there are none', async () => {
    // The failure that would otherwise be silent: a Space with machines showing the message that
    // tells you to go and connect one.
    server.use(
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
      ),
      http.get('*/spaces/acme/machines', () => HttpResponse.error()),
      http.get('*/me', () => HttpResponse.json({ displayName: '', credentials: [], spaces: [] })),
    )
    open('/s/acme')

    const machines = await panel()

    expect(await machines.findByText(/could not read the machines/i)).toBeDefined()
    expect(machines.queryByText(/agents run on/i)).toBeNull()
  })

  it('takes one away when asked', async () => {
    const removed: string[] = []
    server.use(
      ...theSpace([{ id: 'm-1', name: 'mina-mbp', presence: HERE, agents: [] }]),
      http.delete('*/spaces/acme/machines/:id', ({ params }) => {
        removed.push(String(params['id']))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/s/acme')

    const machines = await panel()
    await userEvent.click(await machines.findByRole('button', { name: /remove/i }))

    expect(removed).toEqual(['m-1'])
  })
})

describe('a key for a machine with no browser', () => {
  it('is offered right where the machines are', async () => {
    server.use(
      ...theSpace([]),
      http.post('*/spaces/acme/machine-keys', () =>
        HttpResponse.json(
          { key: 'hk_secret', expiresAt: new Date().toISOString() },
          { status: 201 },
        ),
      ),
    )
    open('/s/acme')

    const machines = await panel()
    await userEvent.click(await machines.findByRole('button', { name: /no browser/i }))

    expect(await machines.findByText(/handover connect --key hk_secret/u)).toBeDefined()
  })

  it('says the key will not be shown again, because only its hash is kept', async () => {
    // Somebody who closes this without copying it needs another key, not a way to look it up.
    server.use(
      ...theSpace([]),
      http.post('*/spaces/acme/machine-keys', () =>
        HttpResponse.json(
          { key: 'hk_secret', expiresAt: new Date().toISOString() },
          { status: 201 },
        ),
      ),
    )
    open('/s/acme')

    const machines = await panel()
    await userEvent.click(await machines.findByRole('button', { name: /no browser/i }))

    expect(await machines.findByText(/shown once/i)).toBeDefined()
  })

  it('says it could not make one, rather than looking like a button that does nothing', async () => {
    server.use(
      ...theSpace([]),
      http.post('*/spaces/acme/machine-keys', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'start-over' }, { status: 404 }),
      ),
    )
    open('/s/acme')

    const machines = await panel()
    await userEvent.click(await machines.findByRole('button', { name: /no browser/i }))

    expect(await machines.findByText(/could not make a key/i)).toBeDefined()
  })
})
