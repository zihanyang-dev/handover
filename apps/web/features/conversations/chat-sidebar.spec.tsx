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
// Installs an `EventSource` this environment does not have. The chat view opens a live stream on
// arrival and would throw before rendering a sidebar at all.
import '../../pretend/event-source.ts'
import { routeTree } from '../../routeTree.gen.ts'

const server = setupServer()

/** One pinned conversation, so the Space's home view has a row to render. */
const THEIRS = {
  id: '11111111-1111-4111-8111-111111111111',
  agentKind: 'claude-code',
  machineId: '33333333-3333-4333-8333-333333333333',
  machineName: 'mbp',
  startedAt: new Date('2026-08-31T09:00:00Z').toISOString(),
  opening: 'Make the timeout configurable',
  startedBy: null,
  pinned: true,
  working: { state: 'idle' },
} as const

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

/**
 * The transcript the chat view loads, emptied down to what the contract requires.
 *
 * Nothing here is about a transcript — these tests are about the sidebar beside it — so it says
 * the least a conversation can say and still be one.
 */
function aTranscript() {
  return http.get(`*/spaces/acme/conversations/${THEIRS.id}`, () =>
    HttpResponse.json({
      id: THEIRS.id,
      agentKind: THEIRS.agentKind,
      machineId: THEIRS.machineId,
      working: { state: 'idle' },
      offers: [],
      messages: [],
    }),
  )
}

/** The sidebar as it is met beside a conversation, which is a different one from the home view's. */
async function openChat() {
  return openAt(`/s/acme/c/${THEIRS.id}`)
}

async function open() {
  return openAt('/s/acme')
}

async function openAt(at: string) {
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

    expect(await screen.findByText(/Could not read your chats/u)).toBeDefined()
  })

  it('shows the list itself when the read worked', async () => {
    server.use(...theSpace())

    await open()

    // The other half of the promise: the message above is about a failure and not a fixture that
    // happens to be empty, so a Space that answers must not be carrying it.
    expect(await screen.findByRole('button', { name: 'Pin' })).toBeDefined()
    expect(screen.queryByText(/Could not read your chats/u)).toBeNull()
  })

  it('names whoever started a conversation that is not yours, and stays quiet on your own', async () => {
    // `06-who-said-what/prd.md` asks for the starter before the title. Not on your own rows: a
    // history is scanned, and your own name down every line of it is what makes the one line that
    // is somebody else's hard to find.
    server.use(
      ...theSpace({
        conversations: [
          { ...THEIRS, startedBy: 'Kai', startedByYou: false },
          {
            ...THEIRS,
            id: '22222222-2222-4222-8222-222222222222',
            opening: 'Mine',
            startedBy: 'Zane',
            startedByYou: true,
          },
        ],
      }),
    )

    await open()

    expect(await screen.findByText('Kai')).toBeDefined()
    expect(screen.queryByText('Zane')).toBeNull()
  })

  it('says an agent list could not be read, instead of showing a Space with no agents', async () => {
    server.use(
      http.get('*/spaces/acme/machines', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'retry-later' }, { status: 500 }),
      ),
      aTranscript(),
      ...theSpace({ conversations: [THEIRS] }),
    )

    await openChat()

    expect(await screen.findByText(/Could not read your machines/u)).toBeDefined()
  })

  it('says a history could not be read, beside a conversation as well as on the way in', async () => {
    server.use(
      http.get('*/spaces/acme/conversations', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'retry-later' }, { status: 500 }),
      ),
      aTranscript(),
      ...theSpace(),
    )

    await openChat()

    expect(await screen.findByText(/Could not read your chats/u)).toBeDefined()
  })
})
