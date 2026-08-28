import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { theSpace } from '../../pretend/a-space.ts'
import { signedIn } from '../../pretend/signed-in.ts'
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

/** The application's own route tree, at a path. A tree built for a test is a different app. */
function open(at: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    // A test does not wait out the fade between routes.
    defaultViewTransition: false,
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const ACME = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  displayName: 'Acme',
  emoji: '🏠',
}
const BETA = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'beta',
  displayName: 'Beta',
  emoji: '🪴',
}

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
  it('somebody with no Spaces is making a workspace right away', async () => {
    server.use(signedIn({ displayName: 'Mina' }))
    open('/onboarding')

    expect(await screen.findByLabelText(/workspace name/i)).toHaveProperty('value', '')
    expect(screen.queryByLabelText(/your name/i)).toBeNull()
  })

  it('shows a non-interactive, readable URL for a name in somebody’s own language', async () => {
    server.use(signedIn())
    open('/onboarding')

    await userEvent.type(await screen.findByLabelText(/workspace name/i), '你好')

    const address = await screen.findByLabelText(/workspace url/i)
    expect(address).toHaveProperty('disabled', true)
    expect(address).toHaveProperty('value', expect.stringMatching(/\/s\/你好$/u))
    expect(address).not.toHaveProperty('value', expect.stringContaining('%'))
  })

  it('keeps several Spaces in a deck until somebody spreads them', async () => {
    server.use(signedIn({ spaces: [ACME, BETA] }))
    open('/onboarding')

    expect(await screen.findByRole('button', { name: /spread 2 spaces/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /open acme/i })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /spread 2 spaces/i }))
    expect(screen.getByRole('button', { name: /open acme/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /open beta/i })).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /stack spaces/i }))
    expect(screen.queryByRole('button', { name: /open acme/i })).toBeNull()
  })

  it('makes the workspace without rewriting the account profile, then advances to Host', async () => {
    let renamed = false
    let made: unknown
    server.use(
      ...quietMachineStep(),
      http.patch('*/me', () => {
        renamed = true
        return HttpResponse.json({}, { status: 200 })
      }),
      http.post('*/spaces', async ({ request }) => {
        made = await request.json()
        return HttpResponse.json(ACME, { status: 201 })
      }),
      signedIn({ displayName: 'Mina' }),
    )
    open('/onboarding')

    await userEvent.type(await screen.findByLabelText(/workspace name/i), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(made).toEqual({ displayName: 'Acme', requestKey: expect.any(String) as unknown })
    expect(renamed).toBe(false)
    expect(await screen.findByRole('heading', { name: /connect a machine/i })).toBeDefined()
    expect(screen.getByRole('img', { name: /step 2 of 2/i })).toBeDefined()
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

    await userEvent.type(await screen.findByLabelText(/workspace name/i), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByText(/acme-2 is free/i)).toBeDefined()
  })

  it('somebody with Spaces is offered them, and picking one goes straight in', async () => {
    server.use(
      // The whole Space, not three calls written out again: landing in one asks for more than
      // the Space itself, and a hand-rolled pair leaves the rest erroring unhandled.
      signedIn({ spaces: [ACME] }),
      ...theSpace({ slug: 'acme' }),
    )
    open('/onboarding')

    await userEvent.click(await screen.findByRole('button', { name: /open acme/i }))

    // Past onboarding entirely: the deliberately blank Home frame, not the legacy dashboard.
    expect(await screen.findByRole('complementary', { name: /Acme sidebar/i })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Home' })).toBeNull()
  })

  it('shows each Space at the address it is at, in the order they were made', async () => {
    // Two promises from `prd.md` 01 that moved here when the Spaces list did: the address is what
    // a Space *is*, and there is no notion of recent — a list that reorders itself is one nobody
    // can learn the shape of.
    server.use(signedIn({ spaces: [ACME, BETA] }))
    open('/onboarding')

    // Spread, because stacked they are a deck and only the top one is readable.
    await userEvent.click(await screen.findByRole('button', { name: /spread 2 spaces/i }))
    const shown = [
      screen.getByRole('button', { name: /open acme/i }),
      screen.getByRole('button', { name: /open beta/i }),
    ]

    expect(shown[0]?.textContent).toContain('/s/acme')
    expect(shown[1]?.textContent).toContain('/s/beta')
    // Made first, shown first. Nothing here has a notion of recent.
    expect(shown[0]?.compareDocumentPosition(shown[1] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('with exactly one Space, still asks rather than going in', async () => {
    // `prd.md` 01 promise ⑤: the URL is the only fact about which Space somebody is in. No
    // default, and not one just because it is the only one — a product that walks you somewhere
    // is one you cannot tell where you are in.
    server.use(signedIn({ spaces: [ACME] }))
    open('/onboarding')

    expect(await screen.findByRole('button', { name: /acme/i })).toBeDefined()
    expect(globalThis.location.pathname).not.toContain('/s/')
  })

  it('opens New Space in a bottom drawer without hiding the existing cards', async () => {
    server.use(signedIn({ spaces: [ACME] }))
    open('/onboarding')

    const make = await screen.findByRole('button', { name: /new space/i })
    const existing = screen.getByRole('button', { name: /open acme/i })
    expect(make.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(make.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(make)
    const name = await screen.findByRole('textbox', { name: /workspace name/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(name)
    })
    const drawer = screen.getByRole('region', { name: /new space drawer/i })
    expect(drawer).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /open acme/i })).toBeDefined()
    expect(make.getAttribute('aria-expanded')).toBe('true')

    expect(screen.getByRole('button', { name: /close new space/i })).toBeDefined()
    await userEvent.click(drawer)
    expect(screen.queryByRole('textbox', { name: /workspace name/i })).toBeNull()
    expect(screen.getByRole('button', { name: /open acme/i })).toBeDefined()
    expect(make.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => {
      expect(document.activeElement).toBe(make)
    })
  })

  it('says once that this way now reaches an account that was already there', async () => {
    server.use(signedIn())
    open('/onboarding?handover_result=merged')

    expect(await screen.findByText(/you already had an account here/i)).toBeDefined()
  })
})
