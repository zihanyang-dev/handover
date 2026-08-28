/**
 * Somebody who was sent a link, and what the three answers look like from where they stand.
 *
 * The one that matters most is the dead link. Revoked, run out, or never a link at all are one
 * answer from the server on purpose — so this screen has to turn that one answer into something
 * with a next step in it, rather than a door with nothing behind it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { theSpace } from '../../pretend/a-space.ts'
import { signedIn } from '../../pretend/signed-in.ts'
import { routeTree } from '../../routeTree.gen.ts'

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

function open(at = '/join/hi_secret') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  return router
}

describe('following a link somebody sent', () => {
  it('says who asked and which Space, before anything happens', async () => {
    // A link is a credential somebody was handed in a chat window. What it opens has to be
    // readable before it is used, or joining is a thing that happens to you.
    server.use(
      signedIn(),
      http.get('*/invitations/hi_secret', () =>
        HttpResponse.json({ slug: 'acme', displayName: 'Acme', invitedBy: 'Kai' }),
      ),
    )
    open()

    expect(await screen.findByRole('heading', { name: 'Kai asked you to join Acme' })).toBeDefined()
  })

  it('lands in the Space, with it now on the list of yours', async () => {
    let asked = 0
    server.use(
      ...theSpace(),
      http.get('*/invitations/hi_secret', () =>
        HttpResponse.json({ slug: 'acme', displayName: 'Acme', invitedBy: 'Kai' }),
      ),
      http.post('*/me/spaces', () => {
        asked += 1
        return HttpResponse.json({ slug: 'acme' })
      }),
      http.get('*/spaces/acme/members', () => HttpResponse.json({ members: [] })),
    )
    const router = open()

    await userEvent.click(await screen.findByRole('button', { name: 'Join Acme' }))

    expect(await screen.findByRole('complementary', { name: /Acme sidebar/i })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Home' })).toBeNull()
    expect([asked, router.state.location.pathname]).toEqual([1, '/s/acme'])
  })

  it('turns a link that stopped working into something to do next', async () => {
    // Revoked, expired and never-a-link are one answer, so this is the only sentence any of them
    // gets — and "ask them for a new one" is the whole of what it is for.
    server.use(
      signedIn(),
      http.get('*/invitations/hi_secret', () =>
        HttpResponse.json({ reason: 'no-invitation', recovery: 'start-over' }, { status: 404 }),
      ),
    )
    open()

    expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeDefined()
    expect(screen.getByText(/Ask them for a new one/)).toBeDefined()
  })

  it('does not call a server that broke a link that is dead', async () => {
    // A 500 is this page failing to read. Telling somebody their link is dead would send them
    // back to ask for another one that works exactly as well as the one they are holding.
    server.use(
      signedIn(),
      http.get('*/invitations/hi_secret', () => new HttpResponse(null, { status: 500 })),
    )
    open()

    expect(await screen.findByRole('heading', { name: 'Could not read this link' })).toBeDefined()
  })
})
