import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../routeTree.gen.ts'

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

const EMAIL = 'mina@example.com'

function signedIn(spaces: { id: string; slug: string; displayName: string }[] = []) {
  return http.get('*/me', () =>
    HttpResponse.json({
      displayName: EMAIL,
      verifiedEmail: EMAIL,
      waysIn: [{ kind: 'email-code', state: 'ready' }],
      spaces,
    }),
  )
}

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

describe('arriving after a trip through a provider', () => {
  it('says once that this way now reaches an account that was already there', async () => {
    server.use(signedIn())
    open('/?handover_result=merged')

    expect(await screen.findByText(/you already had an account here/i)).toBeDefined()
  })

  it('says nothing on an ordinary arrival, and nothing on a reload', async () => {
    server.use(signedIn())
    open('/')

    // The link is made once per provider per account, so the answer that made it is the one time
    // to mention it. A page that remembered would say it again.
    await screen.findByText(/your spaces/i)
    expect(screen.queryByText(/you already had an account here/i)).toBeNull()
  })

  it('says nothing when the trip ended some other way', async () => {
    server.use(signedIn())
    open('/?handover_result=cancelled')

    await screen.findByText(/your spaces/i)
    expect(screen.queryByText(/you already had an account here/i)).toBeNull()
  })
})
