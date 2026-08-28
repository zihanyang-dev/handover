/**
 * That handing a piece of work over, taking it back, and passing it to somebody else each reach
 * the server under a name that survives a lost answer — and that all three read the Inbox again.
 *
 * The Inbox is the point. Handing something over is the only way a row ever arrives in one, and
 * taking it back is the only way a row leaves without being answered. A hook that forgot it leaves
 * somebody looking at a list of things waiting on them that nothing is waiting on.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { inbox } from './talking.ts'
import { useHandOver, useHandWorkTo, useTakeBack } from './work.ts'

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  sessionStorage.clear()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const ID = '11111111-1111-4111-8111-111111111111'
const GOAL = 'make the 30s timeout configurable'

function inABrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  return { wrapper }
}

/** The Inbox, held open the way a screen holds it, and how many times it was asked for. */
function watchingTheInbox<T>(use: () => T) {
  const asked = { times: 0 }
  server.use(
    http.get('*/me/inbox', () => {
      asked.times += 1
      return HttpResponse.json({ waiting: [] })
    }),
  )
  const { wrapper } = inABrowser()
  const screen = renderHook(
    () => ({ inbox: useQuery({ ...inbox(), refetchInterval: false as const }), it: use() }),
    { wrapper },
  )

  return { asked, screen }
}

describe('handing a piece of work over', () => {
  it('is one intention however many times it is pressed', async () => {
    const sent: { key: string; goal: string }[] = []
    server.use(
      http.post(`*/spaces/acme/conversations/${ID}/task`, async ({ request }) => {
        sent.push((await request.json()) as { key: string; goal: string })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { asked, screen } = watchingTheInbox(() => useHandOver('acme', ID))
    await waitFor(() => {
      expect(asked.times).toBe(1)
    })

    // Twice, without waiting: the same card, pressed by somebody who did not see it land.
    screen.result.current.it.mutate(GOAL)
    screen.result.current.it.mutate(GOAL)

    await waitFor(() => {
      expect(sent).toHaveLength(2)
    })
    // The server keeps its promise by the name it is handed, so the two carry one name.
    expect(sent[0]?.key).toBe(sent[1]?.key)
    expect(sent[0]?.goal).toBe(GOAL)
    // Once on arrival, and once after each of the two answers: one name on the wire does not mean
    // one answer coming back, and both answers say the Inbox may have changed.
    await waitFor(() => {
      expect(asked.times).toBe(3)
    })
  })

  it('is a new intention once the last one landed', async () => {
    const sent: { key: string }[] = []
    server.use(
      http.post(`*/spaces/acme/conversations/${ID}/task`, async ({ request }) => {
        sent.push((await request.json()) as { key: string })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { screen } = watchingTheInbox(() => useHandOver('acme', ID))

    screen.result.current.it.mutate(GOAL)
    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    screen.result.current.it.mutate(GOAL)
    await waitFor(() => {
      expect(sent).toHaveLength(2)
    })

    // Said, heard, and said again is two things said — not one retried.
    expect(sent[0]?.key).not.toBe(sent[1]?.key)
  })

  it('says why when there is nothing to hand over', async () => {
    server.use(
      http.post(`*/spaces/acme/conversations/${ID}/task`, () =>
        HttpResponse.json(
          { reason: 'nothing-to-hand-over', recovery: 'start-over' },
          { status: 409 },
        ),
      ),
    )
    const { screen } = watchingTheInbox(() => useHandOver('acme', ID))

    screen.result.current.it.mutate(GOAL)

    await waitFor(() => {
      expect(screen.result.current.it.error?.reason).toBe('nothing-to-hand-over')
    })
  })
})

describe('taking it back', () => {
  it('is one intention too, and the Inbox is read again', async () => {
    const sent: { key: string }[] = []
    server.use(
      http.delete(`*/spaces/acme/conversations/${ID}/task`, async ({ request }) => {
        sent.push((await request.json()) as { key: string })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { asked, screen } = watchingTheInbox(() => useTakeBack('acme', ID))
    await waitFor(() => {
      expect(asked.times).toBe(1)
    })

    screen.result.current.it.mutate()
    screen.result.current.it.mutate()

    await waitFor(() => {
      expect(sent).toHaveLength(2)
    })
    expect(sent[0]?.key).toBe(sent[1]?.key)
    await waitFor(() => {
      expect(asked.times).toBe(3)
    })
  })
})

describe('handing it to somebody else here', () => {
  it('names the person and nothing else, because nothing else moves', async () => {
    const sent: unknown[] = []
    server.use(
      http.patch(`*/spaces/acme/conversations/${ID}/task`, async ({ request }) => {
        sent.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { asked, screen } = watchingTheInbox(() => useHandWorkTo('acme', ID))
    await waitFor(() => {
      expect(asked.times).toBe(1)
    })

    screen.result.current.it.mutate({
      params: { path: { slug: 'acme', id: ID } },
      body: { ownerUserId: '22222222-2222-4222-8222-222222222222' },
    })

    await waitFor(() => {
      expect(asked.times).toBe(2)
    })
    expect(sent).toEqual([{ ownerUserId: '22222222-2222-4222-8222-222222222222' }])
  })
})
