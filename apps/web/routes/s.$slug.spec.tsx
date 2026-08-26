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
