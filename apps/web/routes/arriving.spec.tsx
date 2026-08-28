import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../routeTree.gen.ts'
import { signedIn } from '../pretend/signed-in.ts'

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
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('arriving after a trip through a provider', () => {
  it('names the way in the account started as, and how many now reach it', async () => {
    // `prd.md` 01 ③: merging by a confirmed address is our choice, so it owes somebody the whole
    // picture. Told only "you already had an account", they cannot tell whether it is the one
    // they meant — and the account they are sure they have is the other one.
    server.use(
      signedIn({
        startedWith: 'google',
        credentials: [
          { kind: 'email', address: 'mina@example.com', state: 'ready' },
          { kind: 'google', state: 'ready' },
          { kind: 'github', state: 'connectable' },
        ],
      }),
    )
    open('/?handover_result=merged')

    const said = await screen.findByText(/you already had an account here/i)

    expect(said.textContent).toContain('made with Google')
    // Two, not three: one of those is an offer to connect, not a way in.
    expect(said.textContent).toContain('2 ways')
  })

  it('says nothing on an ordinary arrival, and nothing on a reload', async () => {
    server.use(signedIn())
    open('/')

    // The link is made once per provider per account, so the answer that made it is the one time
    // to mention it. A page that remembered would say it again.
    await screen.findByText(/name your workspace/i)
    expect(screen.queryByText(/you already had an account here/i)).toBeNull()
  })

  it('does not call an ordinary arrival a merge', async () => {
    server.use(signedIn())
    open('/?handover_result=cancelled')

    await screen.findByText(/name your workspace/i)
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
    // Nothing announced either: every one of these is a message about something that was clicked,
    // so it is announced, and this screen was reached without clicking anything.
    server.use(signedIn())
    open('/')

    await screen.findByText(/name your workspace/i)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('owns the answer for an address with no screen', async () => {
    open('/there-is-no-page-here')

    expect(
      await screen.findByRole('heading', { name: /this page is not available/i }),
    ).toBeDefined()
    expect(screen.getByRole('link', { name: /back to your spaces/i })).toBeDefined()
  })
})
