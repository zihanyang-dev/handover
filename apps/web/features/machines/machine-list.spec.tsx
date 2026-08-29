/**
 * That the three things a person does to a machine reach the server, and that the list showing it
 * is read again each time.
 *
 * The list is the only place any of this is visible: an agent's name, whether its machine is
 * here, and whose it is all come back in the same answer. So a write that did not make the list
 * read again is a page that says the old thing until somebody reloads — and the request
 * succeeded, so nothing anywhere complains.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../../generated/api.ts'
import {
  agentsOn,
  machinesIn,
  useDisconnectMachine,
  useHandMachineTo,
  useNameAgent,
} from './machine-list.ts'

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

const MACHINE_ID = '11111111-1111-4111-8111-111111111111'

const MINA_MBP: components['schemas']['Machine'] = {
  id: MACHINE_ID,
  name: 'mina-mbp',
  ownerName: 'Mina',
  yours: true,
  presence: { state: 'here' },
  agents: [
    {
      kind: 'claude-code',
      name: 'Scout',
      atOnce: 3,
      avatarUrl: `/avatars/agents/${MACHINE_ID}/claude-code`,
      version: '2.1.4',
      models: [],
    },
  ],
}

function inABrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  return { wrapper }
}

/** The machines, and how many times they were asked for. Polling is off so the count means this. */
function listing() {
  const asked = { times: 0 }
  const handler = http.get('*/spaces/acme/machines', () => {
    asked.times += 1
    return HttpResponse.json({ machines: [MINA_MBP] })
  })

  return { asked, handler }
}

/** The list, held open the way a screen holds it, so what is invalidated is actually read again. */
function watching<T>(use: () => T) {
  const { wrapper } = inABrowser()

  return renderHook(
    () => ({
      machines: useQuery({ ...machinesIn('acme'), refetchInterval: false as const }),
      it: use(),
    }),
    { wrapper },
  )
}

describe('the agents a Space can reach', () => {
  it('are the agents on its machines, each carrying the machine it is on', async () => {
    const list = listing()
    server.use(list.handler)

    const screen = watching(() => undefined)
    await waitFor(() => {
      expect(screen.result.current.machines.data).toBeDefined()
    })

    expect(agentsOn(screen.result.current.machines.data ?? [])).toEqual([
      {
        machineId: MACHINE_ID,
        machineName: 'mina-mbp',
        kind: 'claude-code',
        name: 'Scout',
        avatarUrl: `/avatars/agents/${MACHINE_ID}/claude-code`,
        models: [],
        isHere: true,
      },
    ])
  })
})

describe('naming an agent', () => {
  it('sends the name, and reads the list it appears in again', async () => {
    const list = listing()
    const sent: unknown[] = []
    server.use(
      list.handler,
      http.patch(`*/me/machines/${MACHINE_ID}/agents/claude-code`, async ({ request }) => {
        sent.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const screen = watching(() => useNameAgent('acme'))
    await waitFor(() => {
      expect(list.asked.times).toBe(1)
    })

    screen.result.current.it.mutate({
      params: { path: { id: MACHINE_ID, kind: 'claude-code' } },
      body: { name: 'Scout' },
    })

    await waitFor(() => {
      expect(list.asked.times).toBe(2)
    })
    expect(sent).toEqual([{ name: 'Scout' }])
  })

  it('takes a name off by sending nothing rather than an empty one', async () => {
    const list = listing()
    const sent: unknown[] = []
    server.use(
      list.handler,
      http.patch(`*/me/machines/${MACHINE_ID}/agents/claude-code`, async ({ request }) => {
        sent.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const screen = watching(() => useNameAgent('acme'))
    await waitFor(() => {
      expect(list.asked.times).toBe(1)
    })

    screen.result.current.it.mutate({
      params: { path: { id: MACHINE_ID, kind: 'claude-code' } },
      body: { name: null },
    })

    await waitFor(() => {
      expect(sent).toEqual([{ name: null }])
    })
  })
})

describe('disconnecting one of your own', () => {
  it('asks under /me, because a machine is not a Space’s to take away', async () => {
    const list = listing()
    const asked: string[] = []
    server.use(
      list.handler,
      http.delete(`*/me/machines/${MACHINE_ID}`, ({ request }) => {
        asked.push(new URL(request.url).pathname)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const screen = watching(() => useDisconnectMachine('acme'))
    await waitFor(() => {
      expect(list.asked.times).toBe(1)
    })

    screen.result.current.it.mutate({ params: { path: { id: MACHINE_ID } } })

    await waitFor(() => {
      expect(list.asked.times).toBe(2)
    })
    expect(asked).toEqual([`/me/machines/${MACHINE_ID}`])
  })
})

describe('handing a machine to somebody here', () => {
  it('asks inside the Space, because who is here is what makes it possible', async () => {
    const list = listing()
    const asked: string[] = []
    server.use(
      list.handler,
      http.patch(`*/spaces/acme/machines/${MACHINE_ID}`, ({ request }) => {
        asked.push(new URL(request.url).pathname)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const screen = watching(() => useHandMachineTo('acme'))
    await waitFor(() => {
      expect(list.asked.times).toBe(1)
    })

    screen.result.current.it.mutate({
      params: { path: { slug: 'acme', id: MACHINE_ID } },
      body: { ownerUserId: '22222222-2222-4222-8222-222222222222' },
    })

    await waitFor(() => {
      expect(list.asked.times).toBe(2)
    })
    expect(asked).toEqual([`/spaces/acme/machines/${MACHINE_ID}`])
  })
})
