import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
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

describe('the Spaces you are in', () => {
  it('reads the same way with none as with many', async () => {
    server.use(signedIn())
    open('/')

    // There is no first-Space case to be caught in, so there is nothing here to special-case.
    expect(await screen.findByText(/your spaces/i)).toBeDefined()
    expect(screen.getByText(/none yet/i)).toBeDefined()
  })

  it('shows each name and the address it is at', async () => {
    server.use(signedIn({ spaces: [{ id: 'a', slug: 'acme', displayName: 'Acme' }] }))
    open('/')

    expect(await screen.findByText('Acme')).toBeDefined()
    expect(screen.getByRole('link', { name: '/s/acme' })).toBeDefined()
  })

  it('keeps them in the order they were made, with no notion of recent', async () => {
    server.use(
      signedIn({
        spaces: [
          { id: 'a', slug: 'first', displayName: 'First' },
          { id: 'b', slug: 'second', displayName: 'Second' },
        ],
      }),
    )
    open('/')

    const shown = await screen.findAllByRole('link', { name: /^\/s\// })

    expect(shown.map((link) => link.textContent)).toEqual(['/s/first', '/s/second'])
  })
})
