import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../pretend/signed-in.ts'

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
const SECOND = 'zane@example.com'
const CHALLENGE = '11111111-1111-4111-8111-111111111111'

/** This account, with the addresses that already reach it. */
function holding(addresses: string[] = [EMAIL]) {
  return signedIn({
    credentials: addresses.map((address) => ({
      kind: 'email' as const,
      address,
      state: 'ready' as const,
    })),
  })
}

function sends(bodies: Record<string, unknown>[] = []) {
  return http.post('*/me/credentials/email-codes', async ({ request }) => {
    bodies.push((await request.json()) as Record<string, unknown>)
    return HttpResponse.json(
      {
        codeId: CHALLENGE,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        resendAfterSeconds: 30,
        digits: 6,
      },
      { status: 201 },
    )
  })
}

function open(at: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [at] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** The panel it lives in. The account screen shows an address elsewhere too, and this is not that. */
async function panel() {
  return within(await screen.findByRole('region', { name: /how you get in/i }))
}

async function ask(address: string): Promise<void> {
  const ways = await panel()
  await userEvent.type(await ways.findByLabelText(/add another address/i), address)
  await userEvent.click(ways.getByRole('button', { name: /send a code/i }))
}

describe('adding another address', () => {
  it('sends a code to the address that was typed', async () => {
    const bodies: Record<string, unknown>[] = []
    server.use(holding(), sends(bodies))
    open('/')

    await ask(SECOND)

    await waitFor(() => {
      expect(bodies[0]).toMatchObject({ email: SECOND })
    })
    expect(await screen.findByLabelText(new RegExp(`code sent to ${SECOND}`, 'iu'))).toBeDefined()
  })

  it('answers on the last digit, with nothing to press', async () => {
    let answered: unknown
    server.use(
      holding(),
      sends(),
      http.post('*/me/credentials', async ({ request }) => {
        answered = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/')
    await ask(SECOND)

    await userEvent.type(
      await screen.findByLabelText(new RegExp(`code sent to ${SECOND}`, 'iu')),
      '493018',
    )

    // All six, not five. The last keystroke is the one it is easy to leave behind.
    await waitFor(() => {
      expect(answered).toEqual({ codeId: CHALLENGE, code: '493018' })
    })
  })

  it('says an address that opens somebody else cannot be taken', async () => {
    server.use(
      holding(),
      sends(),
      http.post('*/me/credentials', () =>
        HttpResponse.json({ reason: 'address-elsewhere', recovery: 'retype' }, { status: 409 }),
      ),
    )
    open('/')
    await ask(SECOND)

    await userEvent.type(
      await screen.findByLabelText(new RegExp(`code sent to ${SECOND}`, 'iu')),
      '493018',
    )

    expect(await screen.findByText(/already opens a different account/i)).toBeDefined()
  })

  it('says why nothing was sent, rather than looking like a button that does nothing', async () => {
    server.use(
      holding(),
      http.post('*/me/credentials/email-codes', () =>
        HttpResponse.json({ reason: 'address-refused', recovery: 'retype' }, { status: 400 }),
      ),
    )
    open('/')

    await ask(SECOND)

    expect(await screen.findByText(/no mail can reach that address/i)).toBeDefined()
  })

  it('goes back to asking for an address, so a wrong one is not a dead end', async () => {
    server.use(holding(), sends())
    open('/')
    await ask(SECOND)

    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }))

    expect(await (await panel()).findByLabelText(/add another address/i)).toBeDefined()
  })
})
