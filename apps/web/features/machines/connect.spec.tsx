import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { signedIn } from '../../pretend/signed-in.ts'
import { waysIn } from '../../pretend/ways-in.ts'
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

const SPACES = [
  { id: 's-1', slug: 'acme', displayName: 'Acme', emoji: '🏠' },
  { id: 's-2', slug: 'beta', displayName: 'Beta', emoji: '🪴' },
]

function waiting(
  machineName = 'mina-mbp',
  existingMachines: readonly {
    readonly id: string
    readonly presence:
      { readonly state: 'here' } | { readonly state: 'gone'; readonly since: string }
  }[] = [],
) {
  return http.get('*/enrolments/:code', () =>
    HttpResponse.json({
      machineName,
      existingMachines,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  )
}

describe('answering a machine', () => {
  it('starts with the one command that makes a code, then finds what somebody typed', async () => {
    server.use(signedIn({ spaces: SPACES }), waiting())
    open('/connect')

    expect(await screen.findByText('handover connect')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeDefined()
    await userEvent.type(screen.getByLabelText(/code/i), 'WDJB-MJHT')
    await userEvent.click(screen.getByRole('button', { name: /find it/i }))

    expect(await screen.findByText('mina-mbp')).toBeDefined()
  })

  it('finds it straight away when the address already carries the code', async () => {
    // The clickable half of what the terminal prints. Somebody who could copy did not have to
    // read eight letters off a screen.
    server.use(signedIn({ spaces: SPACES }), waiting())
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText('mina-mbp')).toBeDefined()
  })

  it('asks only whether it is yours when no Space journey named one', async () => {
    // The machine and CLI never choose a Space. An Account approval leaves it private, while a
    // Space-scoped URL already carries that explicit destination.
    server.use(signedIn({ spaces: SPACES }), waiting())
    open('/connect/WDJB-MJHT')

    await screen.findByText('mina-mbp')

    expect(screen.getByRole('button', { name: /that is mine/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Acme' })).toBeNull()
  })

  it('names the account it would be attached to, before anybody agrees', async () => {
    // How somebody lands on the wrong one: signing in with a way in that turns out to have its
    // own account. They are sure they are on the other one, because on the other one they are.
    server.use(signedIn({ displayName: 'zane', spaces: [] }), waiting())
    open('/connect/WDJB-MJHT')

    await screen.findByText('mina-mbp')

    expect(screen.getByText('zane')).toBeDefined()
    expect(screen.getByRole('button', { name: /that is mine/i })).toBeDefined()
  })

  it('does not turn an email fallback into a label', async () => {
    server.use(signedIn({ displayName: 'mina@example.com', spaces: [] }), waiting())
    open('/connect/WDJB-MJHT')

    await screen.findByText('mina-mbp')

    expect(screen.queryByText('mina@example.com')).toBeNull()
    expect(screen.getByText('Account')).toBeDefined()
  })

  it('says an Account connection can be added to a Space afterwards', async () => {
    server.use(signedIn({ spaces: [] }), waiting())
    open('/connect/WDJB-MJHT')

    await screen.findByText('mina-mbp')

    expect(screen.getByText(/add it to a Space afterwards/i)).toBeDefined()
  })

  it('says nothing of the sort when there is somewhere', async () => {
    server.use(signedIn({ spaces: SPACES }), waiting())
    open('/connect/WDJB-MJHT')

    await screen.findByText('mina-mbp')

    expect(screen.queryByText(/make a Space/i)).toBeNull()
  })

  it('takes it without silently adding it to a Space', async () => {
    const approved: string[] = []
    server.use(
      signedIn({ spaces: SPACES }),
      waiting(),
      http.post('*/me/machines', async ({ request }) => {
        const body = (await request.json()) as { userCode: string }
        approved.push(body.userCode)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: /that is mine/i }))

    expect(approved).toEqual(['WDJB-MJHT'])
    expect(await screen.findByText(/that machine is in/i)).toBeDefined()
  })

  it('adds it to the one Space this journey began in', async () => {
    const approved: unknown[] = []
    server.use(
      signedIn({ spaces: SPACES }),
      waiting(),
      http.post('*/me/machines', async ({ request }) => {
        approved.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/connect/WDJB-MJHT?space=acme')

    expect(await screen.findByText(/available in Acme/u)).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: /that is mine/i }))

    expect(approved).toEqual([{ userCode: 'WDJB-MJHT', spaceSlug: 'acme' }])
  })

  it('does not offer an approval for a Space this account cannot reach', async () => {
    server.use(signedIn({ spaces: SPACES }), waiting())
    open('/connect/WDJB-MJHT?space=somebody-elses')

    expect(await screen.findByText('That Space is not available.')).toBeDefined()
    expect(screen.queryByRole('button', { name: /that is mine/i })).toBeNull()
  })

  it('reconnects the existing identity somebody explicitly chose', async () => {
    const approved: unknown[] = []
    server.use(
      signedIn({ spaces: SPACES }),
      waiting('mina-mbp', [
        {
          id: '11111111-1111-4111-8111-111111111111',
          presence: { state: 'gone', since: '2026-08-30T08:52:52.639Z' },
        },
      ]),
      http.post('*/me/machines', async ({ request }) => {
        approved.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText(/have you connected this machine before/i)).toBeDefined()
    expect(screen.queryByText(/credential|identity/i)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /yes, reconnect it/i }))

    expect(approved).toEqual([
      {
        userCode: 'WDJB-MJHT',
        replaceMachineId: '11111111-1111-4111-8111-111111111111',
      },
    ])
    expect(await screen.findByText(/that machine is in/i)).toBeDefined()
  })

  it('can keep a same-named identity separate when it is really another machine', async () => {
    const approved: unknown[] = []
    server.use(
      signedIn({ spaces: SPACES }),
      waiting('mina-mbp', [
        {
          id: '11111111-1111-4111-8111-111111111111',
          presence: { state: 'here' },
        },
      ]),
      http.post('*/me/machines', async ({ request }) => {
        approved.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(
      await screen.findByRole('button', { name: /no, this is a different machine/i }),
    )

    expect(approved).toEqual([{ userCode: 'WDJB-MJHT' }])
  })

  it('turns it away without naming a Space', async () => {
    let refused = false
    server.use(
      signedIn({ spaces: SPACES }),
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
      signedIn({ spaces: SPACES }),
      waiting(),
      http.post('*/me/machines', () =>
        HttpResponse.json({ reason: 'no-enrolment', recovery: 'start-over' }, { status: 404 }),
      ),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: /that is mine/i }))

    expect(await screen.findByText(/nothing is waiting under that code/i)).toBeDefined()
  })

  it.each(['/connect', '/connect/WDJB-MJHT'])(
    'sends somebody who is not signed in at %s to sign in first',
    async (at) => {
      // The link arrives on a phone as often as not, and a phone is where somebody is least
      // likely to already be signed in. Landing on a blank approval screen would be a dead end.
      server.use(
        // Nobody signed in, which is what a link opened on a phone usually lands as.
        http.get('*/me', () =>
          HttpResponse.json({ reason: 'no-session', recovery: 'sign-in' }, { status: 401 }),
        ),
        waysIn(),
      )
      open(at)

      expect(await screen.findByRole('form', { name: /^sign in$/i })).toBeDefined()
    },
  )

  it.each([
    ['a reason nobody wrote words for', HttpResponse.json({ reason: 'kaboom' }, { status: 500 })],
    ['no answer in the shape it promises', new HttpResponse(null, { status: 502 })],
  ])('still says something when %s comes back', async (_, answer) => {
    // Never a blank screen. Somebody who clicked and saw nothing cannot tell a failure from a
    // click that did not land.
    server.use(
      signedIn({ spaces: SPACES }),
      waiting(),
      http.post('*/me/machines', () => answer.clone()),
    )
    open('/connect/WDJB-MJHT')

    await userEvent.click(await screen.findByRole('button', { name: /that is mine/i }))

    expect(await screen.findByText(/could not be done/i)).toBeDefined()
  })

  it('says something when finding it fails in a way nobody wrote words for', async () => {
    server.use(
      signedIn({ spaces: SPACES }),
      http.get('*/enrolments/:code', () =>
        HttpResponse.json({ reason: 'kaboom', recovery: 'retry-later' }, { status: 500 }),
      ),
    )
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText(/could not be checked/i)).toBeDefined()
  })

  it('says nothing is waiting under a code nobody is using', async () => {
    server.use(
      signedIn({ spaces: SPACES }),
      http.get('*/enrolments/:code', () =>
        HttpResponse.json({ reason: 'no-enrolment', recovery: 'start-over' }, { status: 404 }),
      ),
    )
    open('/connect/WDJB-MJHT')

    expect(await screen.findByText(/nothing is waiting under that code/i)).toBeDefined()
  })

  it('offers no answer at all until it has found something to answer about', async () => {
    // Approving before anything is on screen would be approving whatever happens to be waiting.
    server.use(signedIn({ spaces: SPACES }))
    open('/connect')

    await screen.findByLabelText(/code/i)

    expect(screen.queryByRole('button', { name: 'Acme' })).toBeNull()
  })

  it('lets go of the machine it found once the code has been edited', async () => {
    // The screen would otherwise say code B while the approve button still answers for code A.
    server.use(signedIn({ spaces: SPACES }), waiting())
    open('/connect/WDJB-MJHT')
    await screen.findByText('mina-mbp')

    await userEvent.type(screen.getByLabelText('Code'), 'X')

    expect(screen.queryByText('mina-mbp')).toBeNull()
  })
})
