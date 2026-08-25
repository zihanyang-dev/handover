import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../routeTree.gen.ts'
import { theSpace } from '../a-space.ts'
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
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  // Handed back so a test can ask where the app ended up, which is the whole of what a guard does.
  return router
}

describe('entering a Space', () => {
  it('shows the one at that address', async () => {
    server.use(...theSpace())
    open('/s/acme')

    expect(await screen.findByText('Acme')).toBeDefined()
  })

  it('answers one that is not yours the same as one that is not there', async () => {
    server.use(
      // First, so it answers instead of the one the Space double carries.
      http.get('*/spaces/:slug', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'start-over' }, { status: 404 }),
      ),
      ...theSpace({ slug: 'somebody-elses' }),
    )
    open('/s/somebody-elses')

    // Telling them apart would make the address bar a way to find out what exists.
    expect(await screen.findByText(/this space is not available/i)).toBeDefined()
  })

  it('offers a way out from inside, not only from the Spaces list', async () => {
    // Somebody who came straight to a Space by its address should not have to go somewhere else
    // to leave. `prd.md` asks for this on every screen in here.
    server.use(
      signedIn({ credentials: [{ kind: 'email', address: 'mina@example.com', state: 'ready' }] }),
      ...theSpace(),
    )
    open('/s/acme')

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeDefined()
  })

  it('asks somebody whose session ran out to sign in, and remembers where they were', async () => {
    // Without the guard this reads as a Space that is not there: somebody is told their Space is
    // gone when what really happened is that they need to sign in again. And a sign-in that
    // forgets where they were going leaves them to find it a second time.
    server.use(http.get('*/me', () => new HttpResponse(null, { status: 401 })))

    const router = open('/s/acme')

    expect(await screen.findByText(/sign in or sign up/i)).toBeDefined()
    expect(router.state.location.search).toEqual({ next: '/s/acme' })
  })
})
