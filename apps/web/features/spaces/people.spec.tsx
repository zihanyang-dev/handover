/**
 * What a Space with more than one person in it offers, and to whom.
 *
 * Mostly about what a member is *not* offered. An owner-only endpoint refuses a member anyway, so
 * a button that reaches one is a button that cannot work — and the person pressing it learns that
 * from an error rather than from the screen.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../../generated/api.ts'
import { routeTree } from '../../routeTree.gen.ts'
import { theSpace } from '../../pretend/a-space.ts'

type Member = components['schemas']['Member']
type StillTheirs = components['schemas']['StillTheirs']

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

const KAI: Member = {
  userId: 'u-kai',
  displayName: 'Kai',
  role: 'owner',
  since: '2026-08-01T10:00:00.000Z',
  you: true,
}
const MINA: Member = {
  userId: 'u-mina',
  displayName: 'Mina',
  role: 'member',
  since: '2026-08-20T10:00:00.000Z',
  you: false,
}

function people(...members: readonly Member[]) {
  return http.get('*/spaces/acme/members', () => HttpResponse.json({ members }))
}

function held(still: StillTheirs = { working: [], machines: [] }) {
  return http.get('*/spaces/acme/members/:userId/held', () => HttpResponse.json(still))
}

function open() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/s/acme/people'] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('asking somebody into a Space', () => {
  it('shows the whole link the once, and only after somebody asks for one', async () => {
    // Only its hash is kept, so there is nothing to show on the way in — and a link that appeared
    // without being asked for would be one more live credential per page load.
    server.use(
      ...theSpace(),
      people(KAI),
      http.post('*/spaces/acme/invitations', () =>
        HttpResponse.json(
          { id: 'i-1', link: 'http://localhost:5173/join/hi_secret', expiresAt: '2026-09-01' },
          { status: 201 },
        ),
      ),
    )
    open()

    await userEvent.click(await screen.findByRole('button', { name: 'Make a link' }))

    expect(await screen.findByText('http://localhost:5173/join/hi_secret')).toBeDefined()
    expect(screen.getByText(/Anybody holding this link can join/)).toBeDefined()
  })

  it('offers a member no way in and no way out', async () => {
    // The endpoints behind both refuse a member. Offering them anyway would be this screen
    // promising something the server has already said no to.
    server.use(...theSpace(), people({ ...KAI, you: false }, { ...MINA, you: true }))
    open()

    expect(await screen.findByText('Mina')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Make a link' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull()
  })

  it('says which of them is you, and which of them can let people in', async () => {
    server.use(...theSpace(), people(KAI, MINA))
    open()

    expect(await screen.findByText('you')).toBeDefined()
    expect(screen.getByText('Owner')).toBeDefined()
  })
})

describe('what an owner can change', () => {
  it('makes somebody else an owner', async () => {
    let asked: unknown
    server.use(
      ...theSpace(),
      people(KAI, MINA),
      http.patch('*/spaces/acme/members/u-mina', async ({ request }) => {
        asked = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open()

    await userEvent.click(await screen.findByRole('button', { name: 'Make an owner' }))

    expect(asked).toEqual({ role: 'owner' })
  })

  it('does not offer to change the role of the only person here', async () => {
    // There is nobody to hand it to, and a Space of one is already as owned as it can be.
    server.use(...theSpace(), people(KAI))
    open()

    expect(await screen.findByText('Kai')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Make a member' })).toBeNull()
  })
})

describe('taking somebody out', () => {
  it('shows what is still theirs before the button that does it', async () => {
    // The whole of `prd.md` 05 ⑥: a list to work through, not a button. Nothing on it is stopped
    // or moved by pressing Remove, and that has to be readable *before* pressing it.
    server.use(
      ...theSpace(),
      people(KAI, MINA),
      held({
        working: [
          {
            conversationId: 'c-1',
            goal: 'Watch three days of conversions',
            state: 'working',
            machineName: 'mina-mbp',
          },
        ],
        machines: [{ id: 'm-1', name: 'build-server-1', inUse: 2 }],
      }),
    )
    open()

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('Watch three days of conversions')).toBeDefined()
    expect(screen.getByText('build-server-1')).toBeDefined()
    expect(screen.getByText('2 running on it')).toBeDefined()
    expect(screen.getByText(/Nothing here stops or moves/)).toBeDefined()
  })

  it('tells the only owner what to do instead, rather than what went wrong', async () => {
    // A refusal that says "409" is a dead end. This one is the one refusal with a next step, and
    // the next step is the whole reason the rule exists. `prd.md` 05 ⑤.
    server.use(
      ...theSpace(),
      people(KAI, MINA),
      held(),
      http.delete('*/spaces/acme/members/u-kai', () =>
        HttpResponse.json({ reason: 'the-last-owner', recovery: 'ask-an-owner' }, { status: 409 }),
      ),
    )
    open()

    await userEvent.click(await screen.findByRole('button', { name: 'Leave' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Leave this Space' }))

    expect(
      await screen.findByText('You are the only owner here. Make somebody else an owner first.'),
    ).toBeDefined()
  })
})
