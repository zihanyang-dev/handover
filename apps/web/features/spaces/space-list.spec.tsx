import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../pretend/signed-in.ts'

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
    // Awaited, because "none" is now something this screen waits to be sure of rather than
    // something it assumes while the answer is still coming.
    expect(await screen.findByText(/your spaces/i)).toBeDefined()
    expect(await screen.findByText(/none yet/i)).toBeDefined()
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

  it('does not call a Space it could not read a Space you do not have', async () => {
    // "None yet" is a sentence somebody acts on — they go and make one. Said because the read
    // failed, they make a second Space they already have.
    server.use(http.get('*/me', () => new HttpResponse(null, { status: 500 })))
    open('/')

    expect(await screen.findByText(/could not read your spaces/i)).toBeDefined()
    expect(screen.queryByText(/none yet/i)).toBeNull()
  })
})
