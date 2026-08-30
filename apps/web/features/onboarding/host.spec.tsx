import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { theSpace } from '../../pretend/a-space.ts'
import { signedIn } from '../../pretend/signed-in.ts'
import { routeTree } from '../../routeTree.gen.ts'

const { burstConfetti } = vi.hoisted(() => ({ burstConfetti: vi.fn() }))
vi.mock('../../components/ui/confetti-burst.ts', () => ({ burstConfetti }))

const server = setupServer()
const ACME = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  displayName: 'Acme',
  emoji: '🏠',
}

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

function open(at: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    defaultViewTransition: false,
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function machinesAre(machines: unknown[]) {
  return http.get('*/spaces/:slug/machines', () => HttpResponse.json({ machines }))
}

function keyIs(key: string) {
  return http.post('*/me/machine-keys', () =>
    HttpResponse.json(
      { key, expiresAt: new Date(Date.now() + 900_000).toISOString() },
      { status: 201 },
    ),
  )
}

describe('the second onboarding step — a machine', () => {
  it('keeps the progress rail and starts with the regular command', async () => {
    server.use(signedIn({ spaces: [ACME] }), machinesAre([]))
    open('/onboarding/host?s=acme')

    expect(await screen.findByRole('heading', { name: /connect a machine/i })).toBeDefined()
    expect(screen.getByRole('img', { name: /step 2 of 2/i })).toBeDefined()
    expect(screen.getByText(/^handover connect --origin https?:\/\/\S+$/u)).toBeDefined()
    expect(screen.queryByText(/--key/u)).toBeNull()
  })

  it('keeps the one-time key behind an explicit fallback', async () => {
    server.use(signedIn({ spaces: [ACME] }), machinesAre([]), keyIs('WDJB-MJHT'))
    open('/onboarding/host?s=acme')

    await userEvent.click(await screen.findByRole('button', { name: /use a key instead/i }))

    expect(
      await screen.findByText(/handover connect --origin https?:\/\/\S+ --key WDJB-MJHT/u),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: /use the regular command/i })).toBeDefined()
  })

  it('lets somebody skip into the Space and celebrates only then', async () => {
    server.use(
      signedIn({ spaces: [ACME] }),
      machinesAre([]),
      // Skipping lands in the Space, which asks for more than the Space itself.
      ...theSpace({ slug: 'acme' }),
    )
    open('/onboarding/host?s=acme')

    await userEvent.click(await screen.findByRole('button', { name: /skip for now/i }))

    expect(burstConfetti).toHaveBeenCalledOnce()
    expect(await screen.findByRole('complementary', { name: /Acme sidebar/i })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Home' })).toBeNull()
  })

  it('shows generated agent avatars, lets their owner name them, and leaves Open Space as the action', async () => {
    const named: unknown[] = []
    server.use(
      signedIn({ spaces: [ACME] }),
      machinesAre([
        {
          id: 'm1',
          name: "Mina's MacBook",
          yours: true,
          presence: { state: 'here' },
          agents: [
            {
              kind: 'claude-code',
              name: null,
              avatarUrl: '/avatars/agents/m1/claude-code?v=pixel-art-v1',
              version: '2.1.0',
              models: [],
            },
            {
              kind: 'codex',
              name: null,
              avatarUrl: '/avatars/agents/m1/codex?v=pixel-art-v1',
              version: '0.4.1',
              models: [],
            },
          ],
        },
      ]),
      http.patch('*/me/machines/m1/agents/claude-code', async ({ request }) => {
        named.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/onboarding/host?s=acme')

    expect(await screen.findByText(/Mina's MacBook/)).toBeDefined()
    const agents = screen.getByRole('list', { name: /agents found on Mina's MacBook/i })
    expect(within(agents).getByText(/Claude Code · 2.1.0/u)).toBeDefined()
    expect(within(agents).getByText(/Codex · 0.4.1/u)).toBeDefined()
    expect(
      [...agents.querySelectorAll<HTMLImageElement>('.host-agent-avatar > img')].map((avatar) =>
        avatar.getAttribute('src'),
      ),
    ).toEqual([
      '/avatars/agents/m1/claude-code?v=pixel-art-v1',
      '/avatars/agents/m1/codex?v=pixel-art-v1',
    ])

    expect(within(agents).queryByRole('textbox', { name: /name claude code/i })).toBeNull()
    await userEvent.click(within(agents).getByRole('button', { name: /edit claude code name/i }))
    await userEvent.type(
      within(agents).getByRole('textbox', { name: /name claude code/i }),
      'Scout',
    )
    await userEvent.click(within(agents).getByRole('button', { name: /save claude code name/i }))
    await waitFor(() => {
      expect(named).toEqual([{ name: 'Scout' }])
      expect(within(agents).queryByRole('textbox', { name: /name claude code/i })).toBeNull()
      expect(within(agents).getByRole('button', { name: /edit claude code name/i })).toBeDefined()
    })

    expect(screen.getByRole('button', { name: /open acme/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /skip for now/i })).toBeNull()
  })
})
