import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const EMAIL = 'mina@example.com'

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

describe('your name', () => {
  it('starts as what is saved, and follows it without being pushed', async () => {
    server.use(signedIn())
    open('/')

    // The field follows what is saved without an effect pushing it there, so the value arrives
    // with the query rather than a render later.
    expect(await screen.findByDisplayValue(EMAIL)).toBeDefined()
    expect(screen.getByRole('button', { name: /save/i }).hasAttribute('disabled')).toBe(true)
  })

  it('can be changed, and is trimmed on the way', async () => {
    let saved: unknown
    server.use(
      signedIn(),
      http.patch('*/me', async ({ request }) => {
        saved = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/')

    const field = await screen.findByDisplayValue(EMAIL)
    await userEvent.clear(field)
    await userEvent.type(field, '  Mina Kim  ')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(saved).toEqual({ displayName: 'Mina Kim' })
  })
})

describe('leaving', () => {
  it('revokes the session on the server, not just the cookie in the page', async () => {
    let revoked = false
    server.use(
      signedIn(),
      http.delete('*/browser/sessions/current', () => {
        revoked = true
        return new HttpResponse(null, { status: 204 })
      }),
      http.get('*/auth/credentials', () => HttpResponse.json({ offered: ['email'] })),
    )
    open('/')

    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }))

    // A cookie the page forgets is a session the server would still honour.
    expect(revoked).toBe(true)
    expect(await screen.findByRole('form', { name: /^sign in$/i })).toBeDefined()
  })
})
