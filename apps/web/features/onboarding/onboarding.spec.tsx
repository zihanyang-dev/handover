import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [at] }),
    // A test does not wait out the fade between routes.
    defaultViewTransition: false,
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const ACME = { id: '11111111-1111-4111-8111-111111111111', slug: 'acme', displayName: 'Acme' }

/** The machine step follows a made Space; these answer what it asks. */
function quietMachineStep() {
  return [
    http.post('*/machine-keys', () =>
      HttpResponse.json(
        { key: 'WDJB-MJHT', expiresAt: new Date(Date.now() + 900_000).toISOString() },
        { status: 201 },
      ),
    ),
    http.get('*/spaces/:slug/machines', () => HttpResponse.json({ machines: [] })),
  ]
}

describe('the first step — a Space', () => {
  it('somebody with no Spaces is making one right away, their name already filled in', async () => {
    server.use(signedIn({ displayName: 'Mina' }))
    open('/onboarding')

    const name = await screen.findByLabelText(/your name/i)
    expect(name).toHaveProperty('value', 'Mina')
    expect(screen.getByLabelText(/^space$/i)).toBeDefined()
  })

  it('says how far along this is', async () => {
    server.use(signedIn())
    open('/onboarding')

    expect(await screen.findByText(/step 1 of 2/i)).toBeDefined()
  })

  it('shows the address as a read-only URL while the name is typed', async () => {
    server.use(signedIn())
    open('/onboarding')

    await userEvent.type(await screen.findByLabelText(/^space$/i), 'Acme Corp')

    const address = await screen.findByLabelText(/space url/i)
    expect(address).toHaveProperty('readOnly', true)
    expect(address).toHaveProperty('value', expect.stringMatching(/\/s\/acme-corp$/u))
  })

  it('saves a changed name first, then makes the Space, then moves to the machine', async () => {
    let renamed: unknown
    let made: unknown
    server.use(
      ...quietMachineStep(),
      http.patch('*/me', async ({ request }) => {
        renamed = await request.json()
        return HttpResponse.json({}, { status: 200 })
      }),
      http.post('*/spaces', async ({ request }) => {
        made = await request.json()
        return HttpResponse.json(ACME, { status: 201 })
      }),
      signedIn({ displayName: 'Mina' }),
    )
    open('/onboarding')

    const name = await screen.findByLabelText(/your name/i)
    await userEvent.clear(name)
    await userEvent.type(name, 'Mina Kang')
    await userEvent.type(screen.getByLabelText(/^space$/i), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(renamed).toEqual({ displayName: 'Mina Kang' })
    })
    expect(made).toEqual({ displayName: 'Acme', requestKey: expect.any(String) as unknown })
    expect(await screen.findByText(/connect a machine/i)).toBeDefined()
  })

  it('leaves the name alone when it was not changed', async () => {
    let renamed = false
    server.use(
      ...quietMachineStep(),
      http.patch('*/me', () => {
        renamed = true
        return HttpResponse.json({}, { status: 200 })
      }),
      http.post('*/spaces', () => HttpResponse.json(ACME, { status: 201 })),
      signedIn({ displayName: 'Mina' }),
    )
    open('/onboarding')

    await userEvent.type(await screen.findByLabelText(/^space$/i), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByText(/connect a machine/i)).toBeDefined()
    expect(renamed).toBe(false)
  })

  it('offers the address that is free when the one asked for is held', async () => {
    server.use(
      http.post('*/spaces', () =>
        HttpResponse.json(
          { reason: 'slug-taken', recovery: 'choose-another-name', suggestion: 'acme-2' },
          { status: 409 },
        ),
      ),
      signedIn(),
    )
    open('/onboarding')

    await userEvent.type(await screen.findByLabelText(/^space$/i), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByText(/acme-2 is free/i)).toBeDefined()
  })

  it('somebody with Spaces is offered them, and picking one goes straight in', async () => {
    server.use(
      signedIn({ spaces: [ACME] }),
      http.get('*/spaces/acme', () => HttpResponse.json(ACME)),
      http.get('*/spaces/acme/machines', () => HttpResponse.json({ machines: [] })),
    )
    open('/onboarding')

    await userEvent.click(await screen.findByRole('button', { name: /open acme/i }))

    // Past onboarding entirely: the Space itself, machines and all.
    expect(await screen.findByText(/last seen|online|nothing can run here/i)).toBeDefined()
  })

  it('makes a new Space the first full choice, before the compact existing list', async () => {
    server.use(signedIn({ spaces: [ACME] }))
    open('/onboarding')

    const make = await screen.findByRole('button', { name: /new space/i })
    const existing = screen.getByRole('button', { name: /open acme/i })
    expect(make.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await userEvent.click(make)
    expect(await screen.findByLabelText(/^space$/i)).toBeDefined()
  })

  it('says once that this way now reaches an account that was already there', async () => {
    server.use(signedIn())
    open('/onboarding?handover_result=merged')

    expect(await screen.findByText(/you already had an account here/i)).toBeDefined()
  })
})
