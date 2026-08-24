import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
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

function signedIn(waysIn: { kind: string; state: string }[]) {
  return http.get('*/me', () =>
    HttpResponse.json({ displayName: EMAIL, verifiedEmail: EMAIL, waysIn, spaces: [] }),
  )
}

const ALL = [
  { kind: 'email-code', state: 'ready' },
  { kind: 'google', state: 'ready' },
  { kind: 'github', state: 'connectable' },
]

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

describe('how you get in', () => {
  it('gives every way one of two states and nothing else', async () => {
    server.use(signedIn(ALL))
    open('/')

    expect(await screen.findByText('Emailed code')).toBeDefined()
    expect(screen.getAllByText('Ready')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /connect/i })).toBeDefined()
  })

  it('says who can get in, beside the list rather than in a settings page', async () => {
    server.use(signedIn(ALL))
    open('/')

    // The direct consequence of one address meaning one account: whoever reads that inbox is in.
    expect(
      await screen.findByText(
        /the emailed code always works, because the account is that address/i,
      ),
    ).toBeDefined()
  })

  it('leaves out a provider this deployment has no keys for', async () => {
    server.use(signedIn([{ kind: 'email-code', state: 'ready' }]))
    open('/')

    await screen.findByText('Emailed code')
    expect(screen.queryByText('GitHub')).toBeNull()
  })

  it('sends the browser to the provider when one is connected', async () => {
    const asked: string[] = []
    server.use(
      signedIn(ALL),
      http.post('*/me/sign-in-methods/:provider/start', ({ params }) => {
        asked.push(String(params['provider']))
        return HttpResponse.json({ url: 'https://provider.example/authorize' })
      }),
    )
    open('/')

    await userEvent.click(await screen.findByRole('button', { name: /connect/i }))

    expect(asked).toEqual(['github'])
  })
})
