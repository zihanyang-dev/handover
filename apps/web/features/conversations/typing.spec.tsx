/**
 * That saying you are typing keeps saying it while somebody is, and does not flood.
 *
 * Throttled rather than debounced, which is the whole decision worth a test: what the other side
 * needs is to keep hearing it while somebody is still going. A debounce says nothing until they
 * stop — which is the one moment it does not matter — so a test that only checked "it was sent
 * once" would pass a version that never says it again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serverSends } from '../../pretend/event-source.ts'
import { useSayingYouAreTyping, useWatching } from './talking.ts'

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  vi.useRealTimers()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const ID = '11111111-1111-4111-8111-111111111111'
const KAI = '22222222-2222-4222-8222-222222222222'
const OTHER_MINA = '33333333-3333-4333-8333-333333333333'

/** Every time the server was told, so the count is what is under test rather than a response. */
function counting() {
  const said = { times: 0 }
  server.use(
    http.post(`*/spaces/acme/conversations/${ID}/typing`, () => {
      said.times += 1
      return new HttpResponse(null, { status: 204 })
    }),
  )

  return said
}

function watching() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useWatching('acme', ID, 1, KAI), { wrapper })
}

describe('watching somebody type', () => {
  it('keys presence by person even when two people have the same name', () => {
    vi.useFakeTimers()
    const watched = watching()
    const url = `/spaces/acme/conversations/${ID}/live`

    act(() => {
      serverSends(url, { seen: 'typing', userId: KAI, who: 'Mina' })
      serverSends(url, { seen: 'typing', userId: OTHER_MINA, who: 'Mina' })
    })
    expect(watched.result.current.liveTurn.typing).toEqual([{ id: OTHER_MINA, name: 'Mina' }])

    act(() => {
      vi.advanceTimersByTime(5001)
    })
    expect(watched.result.current.liveTurn.typing).toEqual([])
  })
})

describe('saying you are typing', () => {
  it('says it once for a burst of keystrokes', async () => {
    const said = counting()
    const saying = renderHook(() => useSayingYouAreTyping('acme', ID))

    for (let key = 0; key < 12; key += 1) saying.result.current()

    await vi.waitFor(() => {
      expect(said.times).toBe(1)
    })
  })

  it('says it again while somebody is still going', async () => {
    const said = counting()
    const now = vi.spyOn(Date, 'now')
    const saying = renderHook(() => useSayingYouAreTyping('acme', ID))

    // A real instant rather than zero: the hook holds the last one it said, and starting from
    // zero would make the first keystroke look like one it had just announced.
    const start = 1_700_000_000_000
    now.mockReturnValue(start)
    saying.result.current()
    // Under the throttle: still the same burst, and the other side is still being told.
    now.mockReturnValue(start + 1_500)
    saying.result.current()
    // Past it: somebody still typing two seconds later is somebody still typing.
    now.mockReturnValue(start + 2_100)
    saying.result.current()

    await vi.waitFor(() => {
      expect(said.times).toBe(2)
    })
    now.mockRestore()
  })

  it('is silent about a failure, because a name that does not appear is the same as a pause', async () => {
    const tried = { times: 0 }
    server.use(
      http.post(`*/spaces/acme/conversations/${ID}/typing`, () => {
        tried.times += 1
        return HttpResponse.error()
      }),
    )
    const saying = renderHook(() => useSayingYouAreTyping('acme', ID))

    // Nothing to await and nothing to catch: what this says is kept nowhere, so one that did not
    // arrive costs nothing. Unhandled it would be a rejected promise on every dropped connection.
    expect(() => {
      saying.result.current()
    }).not.toThrow()

    // Waited for all the same. A request still in flight when this test ends is one the test
    // environment tears down under it, and that arrives as a failure belonging to no test at all.
    await vi.waitFor(() => {
      expect(tried.times).toBe(1)
    })
  })
})
