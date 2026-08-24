import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

function open(at: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [at] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const SPACES = [
  { id: 's-1', slug: 'acme', displayName: 'Acme' },
  { id: 's-2', slug: 'beta', displayName: 'Beta' },
]

function signedIn(spaces = SPACES) {
  return http.get('*/me', () =>
    HttpResponse.json({ displayName: 'mina@example.com', credentials: [], spaces }),
  )
}

function waiting(machineName = 'mina-mbp') {
  return http.get('*/enrolments/:code', () =>
    HttpResponse.json({ machineName, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
  )
}

describe('answering a machine', () => {
  it('finds it by a code somebody typed', async () => {
    server.use(signedIn(), waiting())
    open('/connect')

    await userEvent.type(await screen.findByLabelText(/code/i), 'WDJB-MJHT')
    await userEvent.click(screen.getByRole('button', { name: /find it/i }))

    expect(await screen.findByText('mina-mbp')).toBeDefined()
  })

  it('finds it straight away when the address already carries the code', async () => {
    // The clickable half of what the terminal prints. Somebody who could copy did not have to
    // read eight letters off a screen.
    server.use(signedIn(), waiting())
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText('mina-mbp')).toBeDefined()
  })

  it('asks which Space, rather than assuming one', async () => {
    // The machine does not name one — it has no standing to choose — so this is the only place
    // the question gets answered.
    server.use(signedIn(), waiting())
    open('/connect/WDJB-MJHT')

    await screen.findByText('mina-mbp')

    expect(screen.getByRole('button', { name: 'Acme' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeDefined()
  })

  it('lets it in, into the Space that was picked', async () => {
    const approved: string[] = []
    server.use(
      signedIn(),
      waiting(),
      http.post('*/spaces/:slug/enrolments/:code/approve', ({ params }) => {
        approved.push(`${String(params['slug'])}/${String(params['code'])}`)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: 'Beta' }))

    expect(approved).toEqual(['beta/WDJB-MJHT'])
    expect(await screen.findByText(/that machine is in/i)).toBeDefined()
  })

  it('turns it away without naming a Space', async () => {
    let refused = false
    server.use(
      signedIn(),
      waiting(),
      http.post('*/enrolments/:code/refuse', () => {
        refused = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: /not mine/i }))

    expect(refused).toBe(true)
    expect(await screen.findByText(/turned away/i)).toBeDefined()
  })

  it('says so when letting it in did not work, rather than looking like nothing happened', async () => {
    server.use(
      signedIn(),
      waiting(),
      http.post('*/spaces/:slug/enrolments/:code/approve', () =>
        HttpResponse.json({ reason: 'no-enrolment', recovery: 'start-over' }, { status: 404 }),
      ),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: 'Acme' }))

    expect(await screen.findByText(/nothing is waiting under that code/i)).toBeDefined()
  })

  it.each(['/connect', '/connect/WDJB-MJHT'])(
    'sends somebody who is not signed in at %s to sign in first',
    async (at) => {
      // The link arrives on a phone as often as not, and a phone is where somebody is least
      // likely to already be signed in. Landing on a blank approval screen would be a dead end.
      server.use(
        http.get('*/me', () =>
          HttpResponse.json({ reason: 'no-session', recovery: 'sign-in' }, { status: 401 }),
        ),
        http.get('*/auth/credentials', () => HttpResponse.json({ offered: ['email'] })),
      )
      open(at)

      expect(await screen.findByText(/sign in or sign up/i)).toBeDefined()
    },
  )

  it.each([
    ['a reason nobody wrote words for', HttpResponse.json({ reason: 'kaboom' }, { status: 500 })],
    ['no answer in the shape it promises', new HttpResponse(null, { status: 502 })],
  ])('still says something when %s comes back', async (_, answer) => {
    // Never a blank screen. Somebody who clicked and saw nothing cannot tell a failure from a
    // click that did not land.
    server.use(
      signedIn(),
      waiting(),
      http.post('*/spaces/:slug/enrolments/:code/approve', () => answer.clone()),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: 'Acme' }))

    expect(await screen.findByText(/could not be done/i)).toBeDefined()
  })

  it('says something when finding it fails in a way nobody wrote words for', async () => {
    server.use(
      signedIn(),
      http.get('*/enrolments/:code', () =>
        HttpResponse.json({ reason: 'kaboom', recovery: 'retry-later' }, { status: 500 }),
      ),
    )
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText(/could not be checked/i)).toBeDefined()
  })

  it('says nothing is waiting under a code nobody is using', async () => {
    server.use(
      signedIn(),
      http.get('*/enrolments/:code', () =>
        HttpResponse.json({ reason: 'no-enrolment', recovery: 'start-over' }, { status: 404 }),
      ),
    )
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText(/nothing is waiting under that code/i)).toBeDefined()
  })

  it('offers no answer at all until it has found something to answer about', async () => {
    // Approving before anything is on screen would be approving whatever happens to be waiting.
    server.use(signedIn())
    open('/connect')

    await screen.findByLabelText(/code/i)

    expect(screen.queryByRole('button', { name: 'Acme' })).toBeNull()
  })
})
