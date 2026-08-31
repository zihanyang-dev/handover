/**
 * That a list which could not be read says so, rather than showing the empty version of itself.
 *
 * The two are the same picture and they are opposite sentences. An empty Pin section says nobody
 * pinned anything; a failed read says nothing at all, and rendered the same way the quieter one
 * wins — somebody looks at the place they put things, sees it bare, and believes it.
 *
 * `docs/code-style.md` §4.7 is the rule this was breaking: `conversations.data ?? []` folded three
 * different questions — not asked yet, asked and failed, genuinely nothing — into one answer.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { theSpace } from '../../pretend/a-space.ts'
import { routeTree } from '../../routeTree.gen.ts'

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ['/s/acme'] }),
  })

  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('the sidebar', () => {
  it('says a conversation list could not be read, instead of showing none', async () => {
    // The refusal first: `server.use` answers with the earliest handler that matches, and
    // `theSpace` already has one for this call.
    server.use(
      http.get('*/spaces/acme/conversations', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'retry-later' }, { status: 500 }),
      ),
      ...theSpace(),
    )

    await open()

    expect(await screen.findByText(/Could not read your conversations/u)).toBeDefined()
  })

  it('shows the list itself when the read worked', async () => {
    server.use(...theSpace())

    await open()

    // The other half of the promise: the message above is about a failure and not a fixture that
    // happens to be empty, so a Space that answers must not be carrying it.
    expect(await screen.findByRole('button', { name: 'Pin' })).toBeDefined()
    expect(screen.queryByText(/Could not read your conversations/u)).toBeNull()
  })
})
