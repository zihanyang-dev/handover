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
      credentials: [{ kind: 'email', state: 'ready' }],
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

  it('does not call an ordinary arrival a merge', async () => {
    server.use(signedIn())
    open('/?handover_result=cancelled')

    await screen.findByText(/your spaces/i)
    expect(screen.queryByText(/you already had an account here/i)).toBeNull()
  })

  /**
   * Every one of these was silent once, and a test asserted the silence was correct. A trip that
   * failed and said nothing is indistinguishable from a button that does nothing, which is
   * exactly what it looked like the first time somebody tried it for real.
   */
  it.each([
    ['cancelled', /nothing was connected/i],
    ['expired', /took too long/i],
    ['no-verified-email', /no confirmed address/i],
    ['linked-elsewhere', /already connected to a different/i],
    ['already-connected', /already have one of those connected/i],
  ])('says what went wrong when a trip ends in %s', async (result, said) => {
    server.use(signedIn())
    open(`/?handover_result=${result}`)

    expect(await screen.findByText(said)).toBeDefined()
  })

  it('says nothing at all when the trip left nothing behind', async () => {
    server.use(signedIn())
    open('/')

    await screen.findByText(/your spaces/i)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
