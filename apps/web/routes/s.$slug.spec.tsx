import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../routeTree.gen.ts'
import { signedIn } from '../signed-in.ts'

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

describe('entering a Space', () => {
  it('shows the one at that address', async () => {
    server.use(
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
      ),
      http.get('*/spaces/acme/machines', () => HttpResponse.json({ machines: [] })),
      signedIn(),
    )
    open('/s/acme')

    expect(await screen.findByText('Acme')).toBeDefined()
  })

  it('answers one that is not yours the same as one that is not there', async () => {
    server.use(
      http.get('*/spaces/:slug', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'start-over' }, { status: 404 }),
      ),
      http.get('*/spaces/:slug/machines', () => HttpResponse.json({ machines: [] })),
      signedIn(),
    )
    open('/s/somebody-elses')

    // Telling them apart would make the address bar a way to find out what exists.
    expect(await screen.findByText(/this space is not available/i)).toBeDefined()
  })

  it('offers a way out from inside, not only from the Spaces list', async () => {
    // Somebody who came straight to a Space by its address should not have to go somewhere else
    // to leave. `prd.md` asks for this on every screen in here.
    server.use(
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
      ),
      http.get('*/spaces/acme/machines', () => HttpResponse.json({ machines: [] })),
      signedIn({ credentials: [{ kind: 'email', address: 'mina@example.com', state: 'ready' }] }),
    )
    open('/s/acme')

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeDefined()
  })
})
