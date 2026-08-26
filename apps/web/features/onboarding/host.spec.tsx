import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../pretend/signed-in.ts'

const { burstConfetti } = vi.hoisted(() => ({ burstConfetti: vi.fn() }))
vi.mock('../../components/ui/confetti-burst.ts', () => ({ burstConfetti }))

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
  sessionStorage.clear()
  burstConfetti.mockClear()
})
afterAll(() => {
  server.close()
})

/** The application's own route tree, at a path. A tree built for a test is a different app. */
function open(at: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [at] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const ACME = { id: '11111111-1111-4111-8111-111111111111', slug: 'acme', displayName: 'Acme' }

function keyIs(key: string) {
  return http.post('*/machine-keys', () =>
    HttpResponse.json(
      { key, expiresAt: new Date(Date.now() + 900_000).toISOString() },
      { status: 201 },
    ),
  )
}

function machinesAre(machines: unknown[]) {
  return http.get('*/spaces/:slug/machines', () => HttpResponse.json({ machines }))
}

describe('the second step — a machine', () => {
  it('starts with the regular command and keeps the key behind a choice', async () => {
    server.use(signedIn({ spaces: [ACME] }), keyIs('WDJB-MJHT'), machinesAre([]))
    open('/onboarding/host?s=acme')

    expect(await screen.findByText(/^handover connect$/u)).toBeDefined()
    expect(screen.queryByText(/--key/u)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /use a key instead/i }))

    expect(await screen.findByText(/handover connect --key WDJB-MJHT/u)).toBeDefined()
  })

  it('replaces an expired key instead of leaving a dead command to copy', async () => {
    let made = 0
    server.use(
      signedIn({ spaces: [ACME] }),
      machinesAre([]),
      http.post('*/me/machine-keys', () => {
        made += 1
        return HttpResponse.json(
          {
            key: made === 1 ? 'EXPIRED-KEY' : 'FRESH-KEY',
            expiresAt: new Date(Date.now() + (made === 1 ? -1000 : 900_000)).toISOString(),
          },
          { status: 201 },
        )
      }),
    )
    open('/onboarding/host?s=acme')

    await userEvent.click(await screen.findByRole('button', { name: /use a key instead/i }))

    expect(await screen.findByText(/this key can no longer connect/i)).toBeDefined()
    expect(screen.queryByText(/EXPIRED-KEY/u)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /generate a new key/i }))

    expect(await screen.findByText(/handover connect --key FRESH-KEY/u)).toBeDefined()
  })

  it('says how far along this is', async () => {
    server.use(signedIn({ spaces: [ACME] }), keyIs('WDJB-MJHT'), machinesAre([]))
    open('/onboarding/host?s=acme')

    expect(await screen.findByText(/step 2 of 2/i)).toBeDefined()
  })

  it('says who arrived and what it found, once the machine is here', async () => {
    server.use(
      signedIn({ spaces: [ACME] }),
      keyIs('WDJB-MJHT'),
      machinesAre([
        {
          id: 'm1',
          name: "Mina's MacBook",
          presence: { state: 'here' },
          agents: [
            { kind: 'claude-code', version: '2.1.0' },
            { kind: 'codex', version: '0.4.1' },
          ],
        },
      ]),
    )
    open('/onboarding/host?s=acme')

    expect(await screen.findByText(/Mina's MacBook/)).toBeDefined()
    const agents = screen.getByRole('list', { name: /agents found on Mina's MacBook/i })
    expect(within(agents).getByText('Claude Code')).toBeDefined()
    expect(within(agents).getByText('2.1.0')).toBeDefined()
    expect(within(agents).getByText('Codex')).toBeDefined()
    expect(within(agents).getByText('0.4.1')).toBeDefined()
    expect(within(agents).queryByRole('button')).toBeNull()
    expect(within(agents).queryByRole('link')).toBeNull()
    expect(agents.querySelectorAll('svg')).toHaveLength(2)
  })

  it('opens the Space when asked, once a machine is in', async () => {
    server.use(
      signedIn({ spaces: [ACME] }),
      keyIs('WDJB-MJHT'),
      machinesAre([{ id: 'm1', name: "Mina's MacBook", presence: { state: 'here' }, agents: [] }]),
      http.get('*/spaces/acme', () => HttpResponse.json(ACME)),
    )
    open('/onboarding/host?s=acme')

    await userEvent.click(await screen.findByRole('button', { name: /open acme/i }))

    expect(burstConfetti).toHaveBeenCalledOnce()
    expect(await screen.findByText(/no agents found on it yet/i)).toBeDefined()
  })

  it('lets somebody look around first without connecting anything', async () => {
    server.use(
      signedIn({ spaces: [ACME] }),
      keyIs('WDJB-MJHT'),
      machinesAre([]),
      http.get('*/spaces/acme', () => HttpResponse.json(ACME)),
    )
    open('/onboarding/host?s=acme')

    await userEvent.click(await screen.findByRole('button', { name: /skip for now/i }))

    expect(burstConfetti).toHaveBeenCalledOnce()
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeDefined()
    expect(screen.getByRole('complementary', { name: /Acme sidebar/i })).toBeDefined()
  })

  it('asks for a key that names nobody but the person making it', async () => {
    // A machine belongs to whoever connected it, and where it can be reached from follows from
    // where they are a member. A key that named a Space would be asking somebody to decide
    // something that follows from where they already are.
    let asked = ''
    server.use(
      signedIn({ spaces: [ACME] }),
      http.post('*/me/machine-keys', ({ request }) => {
        asked = new URL(request.url).pathname
        return HttpResponse.json(
          { key: 'WDJB-MJHT', expiresAt: new Date(Date.now() + 900_000).toISOString() },
          { status: 201 },
        )
      }),
      machinesAre([]),
    )
    open('/onboarding/host')

    expect(await screen.findByText(/^handover connect$/u)).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: /use a key instead/i }))
    expect(await screen.findByText(/handover connect --key/u)).toBeDefined()
    expect(asked).toBe('/me/machine-keys')
  })

  it('with no Spaces there is nothing to connect to, and it says so by going back', async () => {
    server.use(signedIn())
    open('/onboarding/host')

    // Back at the first step, making one.
    expect(await screen.findByLabelText(/workspace name/i)).toBeDefined()
  })
})
