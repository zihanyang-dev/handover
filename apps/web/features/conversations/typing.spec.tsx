/**
 * That saying you are typing keeps saying it while somebody is, and does not flood.
 *
 * Throttled rather than debounced, which is the whole decision worth a test: what the other side
 * needs is to keep hearing it while somebody is still going. A debounce says nothing until they
 * stop — which is the one moment it does not matter — so a test that only checked "it was sent
 * once" would pass a version that never says it again.
 */

import { renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSayingYouAreTyping } from './talking.ts'

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
    server.use(http.post(`*/spaces/acme/conversations/${ID}/typing`, () => HttpResponse.error()))
    const saying = renderHook(() => useSayingYouAreTyping('acme', ID))

    // Nothing to await and nothing to catch: what this says is kept nowhere, so one that did not
    // arrive costs nothing. Unhandled it would be a rejected promise on every dropped connection.
    expect(() => {
      saying.result.current()
    }).not.toThrow()
  })
})
