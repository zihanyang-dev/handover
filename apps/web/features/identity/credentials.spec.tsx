import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../pretend/signed-in.ts'
import type { Me } from './me.ts'

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

const ALL: Me['credentials'] = [
  { kind: 'email', address: EMAIL, state: 'ready' },
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

/** The panel itself. The account screen shows the address elsewhere too, and this is not that. */
async function panel() {
  return within(await screen.findByRole('region', { name: /how you get in/i }))
}

describe('how you get in', () => {
  it('gives every way one of two states and nothing else', async () => {
    server.use(signedIn({ credentials: ALL }))
    open('/settings')

    const ways = await panel()

    expect(await ways.findByText(EMAIL)).toBeDefined()
    expect(ways.getAllByText('Ready')).toHaveLength(2)
    expect(ways.getByRole('button', { name: /^connect$/i })).toBeDefined()
  })

  it('says who can get in, beside the list rather than in a settings page', async () => {
    server.use(signedIn({ credentials: ALL }))
    open('/settings')

    // The direct consequence of one address meaning one account: whoever reads that inbox is in.
    expect(
      await screen.findByText(/whoever can read one of those inboxes can sign in/i),
    ).toBeDefined()
  })

  it('leaves out a provider this deployment has no keys for', async () => {
    server.use(signedIn({ credentials: [{ kind: 'email', address: EMAIL, state: 'ready' }] }))
    open('/settings')

    const ways = await panel()

    expect(await ways.findByText(EMAIL)).toBeDefined()
    expect(ways.queryByText('GitHub')).toBeNull()
  })

  it('names every address on its own row, so the number of keys is visible', async () => {
    // Folded into one "emailed code" line, nobody could see that two inboxes open this account,
    // and that count is the whole reason the panel exists.
    const second = 'zane@example.com'
    server.use(
      signedIn({
        credentials: [
          { kind: 'email', address: EMAIL, state: 'ready' },
          { kind: 'email', address: second, state: 'ready' },
        ],
      }),
    )
    open('/settings')

    const ways = await panel()

    expect(await ways.findByText(EMAIL)).toBeDefined()
    expect(ways.getByText(second)).toBeDefined()
  })

  it('sends the browser to the provider when one is connected', async () => {
    const asked: string[] = []
    server.use(
      signedIn({ credentials: ALL }),
      http.post('*/me/credentials/:provider/start', ({ params }) => {
        asked.push(String(params['provider']))
        return HttpResponse.json({ url: 'https://provider.example/authorize' })
      }),
    )
    open('/settings')

    await userEvent.click(await (await panel()).findByRole('button', { name: /^connect$/i }))

    expect(asked).toEqual(['github'])
  })
})
