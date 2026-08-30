import { normalizeSlug } from '@handover/universal'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { signedIn } from '../../pretend/signed-in.ts'
import { routeTree } from '../../routeTree.gen.ts'

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

async function type(name: string): Promise<void> {
  const field = await screen.findByLabelText(/space name/i)
  await userEvent.type(field, name)
}

/** The address as the form shows it: a whole URL, in a field nobody can type into. */
async function shownAddress(): Promise<string> {
  return (await screen.findByLabelText(/space url/i)).getAttribute('value') ?? ''
}

function makeIt() {
  return screen.getByRole('button', { name: /continue/i })
}

describe('making a Space', () => {
  it('shows the address while the name is typed, not after it is submitted', async () => {
    server.use(signedIn())
    open('/onboarding')

    await type('Acme Corp')

    expect(await shownAddress()).toContain('/s/acme-corp')
  })

  it('shows exactly what the server would decide, because it is the same function', async () => {
    server.use(signedIn())
    open('/onboarding')

    await type('Ａcme   Corp!!')

    // If these two ever disagreed, the preview would be a promise the server does not keep.
    const shown = normalizeSlug('Ａcme   Corp!!')
    expect(shown).not.toBeNull()
    expect(await shownAddress()).toContain(`/s/${String(shown)}`)
  })

  it('keeps a non-ASCII name as its own characters', async () => {
    server.use(signedIn())
    open('/onboarding')

    await type('徐悦泰 Studio')

    // Its own characters, not percent-encoded noise: this is for somebody to read.
    expect(await shownAddress()).toContain('/s/徐悦泰-studio')
  })

  it('will not submit a name with no address in it, and shows none', async () => {
    server.use(signedIn())
    open('/onboarding')

    await type('!!!')

    expect(await shownAddress()).toBe('')
    expect(makeIt().hasAttribute('disabled')).toBe(true)
  })

  it('offers the address that is free when the one asked for is held', async () => {
    server.use(
      signedIn(),
      http.post('*/spaces', () =>
        HttpResponse.json(
          { reason: 'slug-taken', recovery: 'choose-another-name', suggestion: 'acme-2' },
          { status: 409 },
        ),
      ),
    )
    open('/onboarding')

    await type('Acme')
    await userEvent.click(makeIt())

    expect(await screen.findByText(/acme-2 is free/i)).toBeDefined()
  })

  it('says a call that never arrived could not be sent, rather than going blank', async () => {
    // Nobody answering is not the server saying no. Read as a refusal, this took the whole screen
    // down: what comes back from a dropped connection is not in the shape a refusal is in.
    server.use(
      signedIn(),
      http.post('*/spaces', () => HttpResponse.error()),
    )
    open('/onboarding')

    await type('Acme')
    await userEvent.click(makeIt())

    expect(await screen.findByText(/could not be sent/i)).toBeDefined()
  })
})
