import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { normalizeSlug } from '@handover/universal'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

async function type(name: string): Promise<void> {
  const field = await screen.findByLabelText(/^name$/i)
  await userEvent.type(field, name)
}

describe('making a Space', () => {
  it('shows the address while the name is typed, not after it is submitted', async () => {
    server.use(signedIn())
    open('/')

    await type('Acme Corp')

    expect(await screen.findByText('acme-corp')).toBeDefined()
  })

  it('shows exactly what the server would decide, because it is the same function', async () => {
    server.use(signedIn())
    open('/')

    await type('Ａcme   Corp!!')

    // If these two ever disagreed, the preview would be a promise the server does not keep.
    const shown = normalizeSlug('Ａcme   Corp!!')
    expect(shown).not.toBeNull()
    expect(await screen.findByText(String(shown))).toBeDefined()
  })

  it('keeps a non-ASCII name as its own characters', async () => {
    server.use(signedIn())
    open('/')

    await type('徐悦泰 Studio')

    expect(await screen.findByText('徐悦泰-studio')).toBeDefined()
  })

  it('says when a name has no address in it, and will not submit', async () => {
    server.use(signedIn())
    open('/')

    await type('!!!')

    expect(await screen.findByText(/no address in it/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /make it/i }).hasAttribute('disabled')).toBe(true)
  })

  it('offers the address that is free when the one asked for is held', async () => {
    server.use(
      signedIn(),
      http.post('*/spaces', () =>
        HttpResponse.json(
          { reason: 'slug-taken', recovery: 'choose-another-name', suggestion: 'acme-2' },
          { status: 409 },
        ),
      ),
    )
    open('/')

    await type('Acme')
    await userEvent.click(screen.getByRole('button', { name: /make it/i }))

    expect(await screen.findByText(/acme-2 is free/i)).toBeDefined()
  })
})
