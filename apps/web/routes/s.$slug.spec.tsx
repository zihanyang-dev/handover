import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../routeTree.gen.ts'
import { theSpace } from '../pretend/a-space.ts'
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

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeDefined()
    expect(screen.getByRole('complementary', { name: /Acme sidebar/i })).toBeDefined()
  })

  it('does not expose the deferred Space switcher', async () => {
    server.use(
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
      ),
      signedIn(),
    )
    open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    expect(within(sidebar).queryByRole('button', { name: 'Acme' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: /switch space/i })).toBeNull()
  })

  it('collapses, reopens, and resizes from the keyboard', async () => {
    server.use(
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
      ),
      signedIn(),
    )
    open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    const separator = screen.getByRole('separator')
    separator.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(separator.getAttribute('aria-valuenow')).toBe('278')

    await userEvent.click(within(sidebar).getByRole('button', { name: /close sidebar/i }))
    const reopen = await screen.findByRole('button', { name: /open sidebar/i })
    await userEvent.click(reopen)
    expect(await screen.findByRole('complementary', { name: /Acme sidebar/i })).toBeDefined()
  })

  it('does not call a Space it could not read a Space you do not have', async () => {
    // A read that failed is not a Space that is missing. Told "not available", somebody goes
    // looking for a Space that is theirs and is there, over a moment of no network.
    // A server that answered with a refusal body, which is the shape this took in production and
    // the one the query treated as success: `data` is undefined either way, and `?? null` turned
    // "could not read" into "not yours".
    server.use(
      signedIn(),
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'retry-later' }, { status: 503 }),
      ),
    )
    open('/s/acme')

    expect(await screen.findByText(/could not read this space/i)).toBeDefined()
    expect(screen.queryByText(/not available/i)).toBeNull()
  })

  it('says the same about a connection that never landed', async () => {
    server.use(
      signedIn(),
      http.get('*/spaces/acme', () => HttpResponse.error()),
    )
    open('/s/acme')

    expect(await screen.findByText(/could not read this space/i)).toBeDefined()
  })

  it('keeps the frame across screens, so a sidebar somebody moved stays moved', async () => {
    // The frame is a layout, mounted once. Mounted per screen, opening a conversation puts a new
    // one in its place and the sidebar somebody collapsed is open again.
    server.use(
      ...theSpace({ conversations: [] }),
      http.get('*/me/inbox', () => HttpResponse.json({ waiting: [] })),
      http.get('*/spaces/acme/conversations/c-1', () =>
        HttpResponse.json({
          id: 'c-1',
          agentKind: 'claude-code',
          machineName: 'mina-mbp',
          working: { state: 'idle' },
          offers: [],
          messages: [],
        }),
      ),
    )
    const router = open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    await userEvent.click(within(sidebar).getByRole('button', { name: /close sidebar/i }))
    await screen.findByRole('button', { name: /open sidebar/i })

    await router.navigate({ to: '/s/$slug/c/$id', params: { slug: 'acme', id: 'c-1' } })

    // Still collapsed: the same frame, with something else inside it.
    expect(await screen.findByRole('button', { name: /open sidebar/i })).toBeDefined()
  })

  it('asks somebody whose session ran out to sign in, and remembers where they were', async () => {
    // Being asked to sign in must not cost the address somebody came for — `prd.md` 01 calls
    // that the difference between an interruption and a loss.
    server.use(http.get('*/me', () => new HttpResponse(null, { status: 401 })))
    const router = open('/s/acme')

    await screen.findByRole('form', { name: /^sign in$/i })

    expect(router.state.location.pathname).toBe('/sign-in')
    expect(router.state.location.search).toMatchObject({ next: '/s/acme' })
  })

  it('offers a way out from inside, not only from the Spaces list', async () => {
    // Somebody who came straight to a Space by its address should not have to go somewhere else
    // to reach their account or leave.
    server.use(...theSpace())
    open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    const out = within(sidebar).getByRole('tab', { name: /account/i })

    expect(out.getAttribute('href')).toBe('/settings')
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
})
