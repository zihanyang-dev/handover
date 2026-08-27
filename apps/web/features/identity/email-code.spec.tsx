import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routeTree } from '../../routeTree.gen.ts'
import { signedIn } from '../../pretend/signed-in.ts'

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

const EMAIL = 'mina@example.com'
const CHALLENGE = '11111111-1111-4111-8111-111111111111'

/** The application's own route tree, at a path. A tree built for a test is a different app. */
function open(at: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Where somebody lands after asking for a code, with what the server told them. */
function codeScreen(resendAfterSeconds = '30'): string {
  const search = new URLSearchParams({
    email: EMAIL,
    codeId: CHALLENGE,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    resendAfterSeconds,
    digits: '6',
  })
  return `/sign-in/code?${search.toString()}`
}

function refusing(reason: string, status: number) {
  return http.post('*/browser/sessions', () =>
    HttpResponse.json({ reason, recovery: 'retype' }, { status }),
  )
}

async function typeCode(digits: string): Promise<void> {
  await userEvent.type(await screen.findByLabelText(/6-digit code/i), digits)
}

describe('handing the code back', () => {
  it('submits all six on the sixth digit, with nothing to press', async () => {
    let handed: unknown
    server.use(
      http.post('*/browser/sessions', async ({ request }) => {
        handed = await request.json()
        return HttpResponse.json({ userId: CHALLENGE }, { status: 200 })
      }),
      signedIn({ credentials: [{ kind: 'email', address: EMAIL, state: 'ready' }] }),
    )
    open(codeScreen())

    await typeCode('493018')

    // Whether a request went out is not the question. The last keystroke is the one that is
    // easy to leave behind, and a code missing it is the code somebody is told is wrong.
    await waitFor(() => {
      expect(handed).toEqual({ codeId: CHALLENGE, code: '493018' })
    })
    // The real route tree, so this is where somebody actually ends up: onboarding, the first
    // step asking for a Space's name.
    expect(await screen.findByRole('heading', { name: /name your workspace/i })).toBeDefined()
  })

  it('will not send five of them, however somebody asks it to', async () => {
    // The sixth digit sends it, so anything else that can send is a way to spend an attempt on a
    // code nobody finished typing — and to be told it is wrong when it was only unfinished.
    let handed = false
    server.use(
      http.post('*/browser/sessions', () => {
        handed = true
        return HttpResponse.json({ userId: CHALLENGE }, { status: 200 })
      }),
    )
    open(codeScreen())

    await typeCode('49301')
    await userEvent.keyboard('{Enter}')

    // Asserted before anything else is looked at, so a failure here says "it sent five" rather
    // than "a button had different words on it".
    expect(handed).toBe(false)

    const press = await screen.findByRole('button', { name: /continue|signing in/i })
    expect(press.hasAttribute('disabled')).toBe(true)
    await userEvent.click(press)
    expect(handed).toBe(false)
  })

  it('does not submit before there are six', async () => {
    let handed = false
    server.use(
      http.post('*/browser/sessions', () => {
        handed = true
        return HttpResponse.json({ userId: CHALLENGE }, { status: 200 })
      }),
    )
    open(codeScreen())

    await typeCode('49301')

    expect(handed).toBe(false)
  })

  it('says the address the code went to', async () => {
    open(codeScreen())

    expect(await screen.findByText(EMAIL)).toBeDefined()
  })

  it('makes somebody wait before another code, and says how long', async () => {
    open(codeScreen())

    const again = await screen.findByRole('button', { name: /resend in \d+s/i })

    expect(again.hasAttribute('disabled')).toBe(true)
  })

  it('carries the address back, so nobody retypes what they just typed', async () => {
    open(codeScreen())

    const back = await screen.findByRole('link', { name: /use a different address/i })

    expect(back.getAttribute('href')).toContain(encodeURIComponent(EMAIL))
  })
})

describe('asking for another one', () => {
  it('says why nothing was sent, rather than looking like a button that does nothing', async () => {
    server.use(
      http.post('*/auth/email-codes', () =>
        HttpResponse.json({ reason: 'address-refused', recovery: 'retype' }, { status: 400 }),
      ),
    )
    open(codeScreen('0'))

    await userEvent.click(await screen.findByRole('button', { name: /resend/i }))

    expect(await screen.findByText(/no mail can reach that address/i)).toBeDefined()
  })
})

describe('each way it can fail', () => {
  const said: readonly [string, number, RegExp][] = [
    ['code-mismatch', 400, /not right/i],
    ['expired', 409, /expired/i],
    ['consumed', 409, /already been used/i],
    ['attempts-exhausted', 429, /too many tries/i],
    ['no-code', 404, /no longer here/i],
  ]

  for (const [reason, status, words] of said) {
    it(`explains ${reason} in words about what to do`, async () => {
      server.use(refusing(reason, status))
      open(codeScreen())

      await typeCode('000000')

      expect(await screen.findByText(words)).toBeDefined()
    })
  }

  it('never tells somebody a used code was simply wrong', async () => {
    server.use(refusing('consumed', 409))
    open(codeScreen())

    await typeCode('000000')

    // Only one of these two means somebody else may have signed in with it.
    const shown = await screen.findByText(/already been used/i)
    expect(shown.textContent).not.toMatch(/not right/i)
  })

  it('ends where the person was going, not at the front door', async () => {
    // The other half of the guard: being asked to sign in must not cost somebody the address they
    // came for. Journey 01 says so, and it is the difference between an interruption and a loss.
    server.use(
      signedIn(),
      http.post('*/browser/sessions', () =>
        HttpResponse.json({ userId: CHALLENGE }, { status: 200 }),
      ),
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ id: 'a', slug: 'acme', displayName: 'Acme' }),
      ),
      http.get('*/spaces/acme/machines', () => HttpResponse.json({ machines: [] })),
      http.get('*/spaces/acme/conversations', () => HttpResponse.json({ conversations: [] })),
      http.get('*/me/inbox', () => HttpResponse.json({ waiting: [] })),
    )
    open(`${codeScreen()}&next=%2Fs%2Facme`)

    await typeCode('493018')

    // Named in the frame twice — the workspace pill and the breadcrumb — which is the Space
    // page and not the front door, and that is the whole of what this test is about.
    expect(await screen.findAllByText('Acme')).not.toHaveLength(0)
  })

  it('refuses to be sent to somebody else s site by its own address bar', async () => {
    server.use(
      signedIn(),
      http.post('*/browser/sessions', () => HttpResponse.json({ userId: CHALLENGE })),
    )
    open(`${codeScreen()}&next=https%3A%2F%2Fevil.example.com%2Fphish`)

    await typeCode('493018')

    // The front door, which is where somebody picks a Space — not the address they were sent to.
    expect(await screen.findByText(/name your workspace/i)).toBeDefined()
  })

  it('sends a half-written address back to where codes come from', async () => {
    // Somebody who typed or shared the URL wrong gets the screen that can put it right, not the
    // router's own error page.
    server.use(signedIn())
    open('/sign-in/code?email=mina%40example.com')

    expect(await screen.findByRole('form', { name: /sign in/i })).toBeDefined()
  })
})
