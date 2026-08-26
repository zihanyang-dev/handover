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
    expect(screen.getByText(/Claude Code 2\.1\.0/)).toBeDefined()
    expect(screen.getByText(/Codex 0\.4\.1/)).toBeDefined()
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

    await userEvent.click(await screen.findByRole('button', { name: /not now/i }))

    expect(await screen.findByText(/nothing can run here yet/i)).toBeDefined()
  })

  it('with exactly one Space, the Space need not be named in the address', async () => {
    let asked = ''
    server.use(
      signedIn({ spaces: [ACME] }),
      http.post('*/spaces/:slug/machine-keys', ({ params }) => {
        asked = String(params['slug'])
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
    expect(asked).toBe('acme')
  })

  it('with no Spaces there is nothing to connect to, and it says so by going back', async () => {
    server.use(signedIn())
    open('/onboarding/host')

    // Back at the first step, making one.
    expect(await screen.findByLabelText(/^space$/i)).toBeDefined()
  })
})
