/**
 * That a link can be made, listed and stopped — and that the list is read again each time.
 *
 * The plaintext is checked for once and never again on purpose: it comes back from making one and
 * from nothing else, so a screen that lost it has lost it. A test that could read it from the list
 * would be testing a server that gave it away twice.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../../generated/api.ts'
import { linksInto, useMakeLink, useStopLink } from './invitations.ts'

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

const ID = '11111111-1111-4111-8111-111111111111'
const EXPIRES = '2026-09-01T09:00:00.000Z'

function inABrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  return { wrapper }
}

/** The live links, and how many times they were asked for. Typed, so it cannot invent a field. */
function listing(rows: readonly components['schemas']['OpenInvitation'][]) {
  const asked = { times: 0 }
  const handler = http.get('*/spaces/acme/invitations', () => {
    asked.times += 1
    return HttpResponse.json({ invitations: rows })
  })

  return { asked, handler }
}

describe('a link into a Space', () => {
  it('shows its plaintext once, and is in the list afterwards', async () => {
    const list = listing([{ id: ID, expiresAt: EXPIRES }])
    server.use(
      list.handler,
      http.post('*/spaces/acme/invitations', () =>
        HttpResponse.json(
          { id: ID, link: 'http://localhost:5173/join/hi_secret', expiresAt: EXPIRES },
          { status: 201 },
        ),
      ),
    )
    const { wrapper } = inABrowser()

    const screen = renderHook(
      () => ({ links: useQuery(linksInto('acme')), make: useMakeLink('acme') }),
      { wrapper },
    )
    await waitFor(() => {
      expect(list.asked.times).toBe(1)
    })

    screen.result.current.make.mutate({ params: { path: { slug: 'acme' } } })

    await waitFor(() => {
      expect(screen.result.current.make.data?.link).toContain('/join/')
    })
    // The one place it is ever readable is the answer above. The list carries no secret at all.
    await waitFor(() => {
      expect(list.asked.times).toBe(2)
    })
    expect(screen.result.current.links.data?.[0]).not.toHaveProperty('link')
  })

  it('is read again once one has been stopped', async () => {
    const list = listing([{ id: ID, expiresAt: EXPIRES }])
    server.use(
      list.handler,
      http.delete(`*/spaces/acme/invitations/${ID}`, () => new HttpResponse(null, { status: 204 })),
    )
    const { wrapper } = inABrowser()

    const screen = renderHook(
      () => ({ links: useQuery(linksInto('acme')), stop: useStopLink('acme') }),
      { wrapper },
    )
    await waitFor(() => {
      expect(list.asked.times).toBe(1)
    })

    screen.result.current.stop.mutate({ params: { path: { slug: 'acme', id: ID } } })

    await waitFor(() => {
      expect(list.asked.times).toBe(2)
    })
  })

  it('says an owner is what it takes, rather than failing without words', async () => {
    server.use(
      listing([]).handler,
      http.post('*/spaces/acme/invitations', () =>
        HttpResponse.json({ reason: 'not-an-owner', recovery: 'ask-an-owner' }, { status: 403 }),
      ),
    )
    const { wrapper } = inABrowser()

    const make = renderHook(() => useMakeLink('acme'), { wrapper })
    make.result.current.mutate({ params: { path: { slug: 'acme' } } })

    await waitFor(() => {
      expect(make.result.current.error?.recovery).toBe('ask-an-owner')
    })
  })
})
