/**
 * That what a page does about who is here reaches the server, and that the page then re-reads
 * everything that just stopped being true.
 *
 * The second half is the one worth a test. A call that goes out is checked by the types; a list
 * that is not read again afterwards is a screen showing somebody who is no longer there, and it
 * fails silently — the request succeeded, so nothing anywhere says anything is wrong.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../../generated/api.ts'
import { machinesIn } from '../machines/machine-list.ts'
import { peopleIn, useChangeRole, useRemoveMember, whatTheyHold } from './people.ts'

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

type Member = components['schemas']['Member']

const MINA: Member = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Mina',
  avatarUrl: '/avatars/users/11111111-1111-4111-8111-111111111111',
  role: 'owner',
  since: '2026-08-01T09:00:00.000Z',
  you: true,
}

const RUI: Member = {
  ...MINA,
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Rui',
  role: 'member',
  you: false,
}

/** One client per test, so nothing one of them cached is another one's starting point. */
function inABrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  return { client, wrapper }
}

/** How many times the server was asked for each of the two lists a removal changes. */
function counting() {
  const asked = { members: 0, machines: 0 }

  return {
    asked,
    handlers: [
      http.get('*/spaces/acme/members', () => {
        asked.members += 1
        return HttpResponse.json({ members: [MINA, RUI] })
      }),
      http.get('*/spaces/acme/machines', () => {
        asked.machines += 1
        return HttpResponse.json({ machines: [] })
      }),
    ],
  }
}

describe('who is in a Space', () => {
  it('is read from the one place, whichever screen asks', async () => {
    const counted = counting()
    server.use(...counted.handlers)
    const { client, wrapper } = inABrowser()

    const here = renderHook(() => useQuery(peopleIn('acme')), { wrapper })
    await waitFor(() => {
      expect(here.result.current.data).toEqual([MINA, RUI])
    })

    // Named by the read itself: a second caller asking the same way lands in the slot this one
    // filled, rather than in one spelled slightly differently beside it.
    expect(client.getQueryData(peopleIn('acme').queryKey)).toEqual({ members: [MINA, RUI] })
    expect(counted.asked.members).toBe(1)
  })

  it('asks what somebody still holds before anybody decides anything', async () => {
    server.use(
      http.get(`*/spaces/acme/members/${RUI.userId}/held`, () =>
        HttpResponse.json({
          working: [
            {
              conversationId: '33333333-3333-4333-8333-333333333333',
              goal: 'watch the numbers',
              state: 'wait',
              machineName: 'rui-mbp',
            },
          ],
          machines: [{ id: '44444444-4444-4444-8444-444444444444', name: 'rui-mbp', inUse: 1 }],
        }),
      ),
    )
    const { wrapper } = inABrowser()

    const held = renderHook(() => useQuery(whatTheyHold('acme', RUI.userId)), { wrapper })

    await waitFor(() => {
      expect(held.result.current.data?.machines).toHaveLength(1)
    })
    expect(held.result.current.data?.working[0]?.goal).toBe('watch the numbers')
  })
})

describe('changing what somebody may do here', () => {
  it('sends the role, and reads who is here again', async () => {
    const counted = counting()
    const sent: unknown[] = []
    server.use(
      ...counted.handlers,
      http.patch(`*/spaces/acme/members/${RUI.userId}`, async ({ request }) => {
        sent.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { wrapper } = inABrowser()

    // Read and written together, the way a screen holds them: only a list somebody is looking at
    // is read again, so a test that never looked would pass whatever this hook invalidated.
    const screen = renderHook(
      () => ({ here: useQuery(peopleIn('acme')), change: useChangeRole('acme') }),
      { wrapper },
    )
    await waitFor(() => {
      expect(screen.result.current.here.data).toHaveLength(2)
    })

    screen.result.current.change.mutate({
      params: { path: { slug: 'acme', userId: RUI.userId } },
      body: { role: 'owner' },
    })

    await waitFor(() => {
      expect(counted.asked.members).toBe(2)
    })
    expect(sent).toEqual([{ role: 'owner' }])
  })

  it('says why when it would leave the Space with no owner', async () => {
    server.use(
      ...counting().handlers,
      http.patch(`*/spaces/acme/members/${MINA.userId}`, () =>
        HttpResponse.json({ reason: 'last-owner', recovery: 'ask-an-owner' }, { status: 409 }),
      ),
    )
    const { wrapper } = inABrowser()

    const change = renderHook(() => useChangeRole('acme'), { wrapper })
    change.result.current.mutate({
      params: { path: { slug: 'acme', userId: MINA.userId } },
      body: { role: 'member' },
    })

    // The refusal arrives as itself, not as a sentence somebody has to parse back out again.
    await waitFor(() => {
      expect(change.result.current.error?.reason).toBe('last-owner')
    })
  })
})

describe('taking somebody out', () => {
  it('reads the machines again as well, because theirs went with them', async () => {
    const counted = counting()
    server.use(
      ...counted.handlers,
      http.delete(
        `*/spaces/acme/members/${RUI.userId}`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    )
    const { wrapper } = inABrowser()
    const screen = renderHook(
      () => ({
        here: useQuery(peopleIn('acme')),
        machines: useQuery(machinesIn('acme')),
        remove: useRemoveMember('acme'),
      }),
      { wrapper },
    )
    await waitFor(() => {
      expect(counted.asked).toEqual({ members: 1, machines: 1 })
    })

    screen.result.current.remove.mutate({ params: { path: { slug: 'acme', userId: RUI.userId } } })

    await waitFor(() => {
      expect(counted.asked).toEqual({ members: 2, machines: 2 })
    })
  })
})
