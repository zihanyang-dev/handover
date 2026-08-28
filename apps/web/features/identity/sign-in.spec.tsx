import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { waysIn } from '../../pretend/ways-in.ts'
import { routeTree } from '../../routeTree.gen.ts'

const server = setupServer()

beforeAll(() => {
  // A request nobody stubbed is a test that would have gone to the network. Say so.
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

/** The application's own route tree, at a path. A tree built for a test is a different app. */
function open(at: string) {
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

const CHALLENGE = '11111111-1111-4111-8111-111111111111'

/** The code screen asks for nothing on arrival; landing on it is what a test checks. */
function answering(bodies: Record<string, unknown>[]) {
  return http.post('*/auth/email-codes', async ({ request }) => {
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

describe('choosing a way in', () => {
  it('says one address is one account before anything is chosen', async () => {
    server.use(waysIn('google'))
    open('/sign-in')

    const said = await screen.findByText(/the same address reaches the same account/i)
    const google = await screen.findByRole('button', { name: /continue with google/i })

    // Whether somebody dares click a different button than last time is decided by reading this
    // first. After the choice it is the same as not saying it.
    expect(said.compareDocumentPosition(google)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('labels the form without repeating the obvious task on the page', async () => {
    server.use(waysIn('google'))
    open('/sign-in')

    const form = await screen.findByRole('form', { name: /^sign in$/i })
    const google = await screen.findByRole('button', { name: /continue with google/i })

    expect(form.contains(google)).toBe(true)
    expect(screen.queryByRole('heading', { name: /^sign in$/i })).toBeNull()
  })

  it('offers only what this deployment has keys for', async () => {
    server.use(waysIn('google'))
    open('/sign-in')

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /continue with github/i })).toBeNull()
  })

  it('offers no provider at all when there are none', async () => {
    server.use(waysIn())
    open('/sign-in')

    await screen.findByLabelText(/email address/i)
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull()
  })

  it('asks for a code and lands on the screen that takes it', async () => {
    const bodies: Record<string, unknown>[] = []
    server.use(waysIn(), answering(bodies))
    open('/sign-in')

    await userEvent.type(await screen.findByLabelText(/email address/i), 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // The real route tree, so this is the screen somebody would actually arrive at.
    expect(await screen.findByText(/check your email/i)).toBeDefined()
    expect(bodies[0]).toMatchObject({ email: 'mina@example.com' })
  })

  it('says an address cannot be reached instead of sending somebody to an empty inbox', async () => {
    server.use(
      waysIn(),
      http.post('*/auth/email-codes', () =>
        HttpResponse.json({ reason: 'address-refused', recovery: 'retype' }, { status: 400 }),
      ),
    )
    open('/sign-in')

    const field = await screen.findByLabelText(/email address/i)
    await userEvent.type(field, 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const error = await screen.findByRole('alert')
    expect(error.textContent).toMatch(/no mail can reach that address/i)
    expect(field.getAttribute('aria-describedby')).toBe(error.id)
    // Staying put is the point: the code screen would be a wait for a letter that never comes.
    expect(screen.queryByText(/check your email/i)).toBeNull()
  })

  it('reuses one key across a retry, so one intention is never two mails', async () => {
    const bodies: Record<string, unknown>[] = []
    let attempt = 0
    server.use(
      waysIn(),
      http.post('*/auth/email-codes', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>)
        attempt += 1
        // The first answer never arrives. This is the case the key exists for.
        if (attempt === 1) return HttpResponse.error()
        return HttpResponse.json(
          {
            codeId: CHALLENGE,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            resendAfterSeconds: 30,
            digits: 6,
          },
          { status: 201 },
        )
      }),
    )
    open('/sign-in')

    await userEvent.type(await screen.findByLabelText(/email address/i), 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => {
      expect(bodies).toHaveLength(1)
    })

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText(/check your email/i)

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.['requestKey']).toBe(bodies[1]?.['requestKey'])
  })

  it('says what to do when a code went out moments ago', async () => {
    server.use(
      waysIn(),
      http.post('*/auth/email-codes', () =>
        HttpResponse.json({ reason: 'too-soon', recovery: 'wait' }, { status: 429 }),
      ),
    )
    open('/sign-in')

    await userEvent.type(await screen.findByLabelText(/email address/i), 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/a code just went out/i)).toBeDefined()
  })
})
