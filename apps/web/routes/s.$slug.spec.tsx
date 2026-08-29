import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { theSpace } from '../pretend/a-space.ts'
import { signedIn } from '../pretend/signed-in.ts'
import { waysIn } from '../pretend/ways-in.ts'
import { routeTree } from '../routeTree.gen.ts'

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
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  // Handed back so a test can ask where the app ended up, which is the whole of what a guard does.
  return router
}

describe('entering a Space', () => {
  it('shows the one at that address', async () => {
    server.use(
      ...theSpace(),
      http.get('*/me/inbox', () => HttpResponse.json({ waiting: [] })),
    )
    const router = open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    expect(screen.queryByRole('heading', { name: 'Home' })).toBeNull()
    expect(document.querySelector('.home-breadcrumb')).toBeNull()
    const switches = within(sidebar).getByRole('group', { name: /sidebar views/i })
    const home = within(switches).getByRole('button', { name: 'Home' })
    const chat = within(switches).getByRole('button', { name: 'Chat' })
    const inbox = within(switches).getByRole('link', { name: 'Inbox' })

    expect(within(switches).getAllByRole('button')).toHaveLength(2)
    expect(home.getAttribute('aria-pressed')).toBe('true')
    expect(chat.getAttribute('aria-pressed')).toBe('false')
    expect(inbox.getAttribute('aria-current')).toBeNull()

    await userEvent.click(chat)

    expect(home.getAttribute('aria-pressed')).toBe('false')
    expect(chat.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('heading', { name: 'Home' })).toBeNull()
    expect(sidebar.querySelector('.home-workspace-icon')).toBeNull()
    expect(within(sidebar).queryByText('Conversations')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Machines' })).toBeNull()
    expect(screen.queryByText('handover connect')).toBeNull()

    await userEvent.click(inbox)

    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeDefined()
    expect(router.state.location.pathname).toBe('/s/acme/inbox')
  })

  it('keeps pinned conversations directly under Home', async () => {
    server.use(
      ...theSpace({
        conversations: [
          {
            id: 'c-pinned',
            agentKind: 'claude-code',
            machineId: 'm-1',
            machineName: 'mina-mbp',
            startedAt: new Date().toISOString(),
            opening: 'keep the release moving',
            startedBy: 'Mina',
            pinned: true,
            working: { state: 'idle' },
          },
        ],
      }),
    )
    open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    expect(within(sidebar).getByRole('button', { name: 'Pin' })).toBeDefined()
    expect(await within(sidebar).findByText('keep the release moving')).toBeDefined()
    expect(within(sidebar).queryByText(/^Mina ·/)).toBeNull()
  })

  it('selects an agent without creating a conversation', async () => {
    server.use(
      ...theSpace({
        machines: [
          {
            id: 'm-1',
            name: 'mina-mbp',
            ownerName: 'Mina',
            yours: true,
            presence: { state: 'here' },
            agents: [
              {
                kind: 'claude-code',
                name: 'Scout',
                version: '2.1.4',
                models: [],
              },
            ],
          },
        ],
        conversations: [
          {
            id: 'c-today',
            agentKind: 'claude-code',
            machineId: 'm-1',
            machineName: 'mina-mbp',
            startedAt: new Date().toISOString(),
            opening: 'ship the sidebar',
            startedBy: 'Mina',
            pinned: false,
            working: { state: 'idle' },
          },
        ],
      }),
    )
    const router = open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    await userEvent.click(within(sidebar).getByRole('button', { name: 'Chat' }))

    expect(await within(sidebar).findByRole('heading', { name: 'Agents' })).toBeDefined()
    const agent = within(sidebar).getByRole('link', {
      name: /Scout, Claude Code on mina-mbp, ready/i,
    })
    expect(within(agent).getByText('Scout')).toBeDefined()
    expect(within(agent).queryByText('Claude Code')).toBeNull()
    expect(agent.querySelector('img')?.getAttribute('src')).toBe(
      '/avatars/agents/m-1/claude-code?v=pixel-art-v1',
    )

    await userEvent.click(agent)

    expect(router.state.location.pathname).toBe('/s/acme/a/m-1/claude-code')
    expect(await screen.findByRole('heading', { name: 'How can Scout help?' })).toBeDefined()
    expect(within(sidebar).queryByRole('button', { name: /new agent/i })).toBeNull()
    expect(within(sidebar).getByRole('heading', { name: 'Today' })).toBeDefined()
    expect(within(sidebar).getByText('ship the sidebar')).toBeDefined()
    expect(within(sidebar).queryByText(/^Mina ·/)).toBeNull()
    expect(within(sidebar).queryByRole('button', { name: /new chat/i })).toBeNull()
  })

  const WHERE = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

  /** One agent on one machine, and a note of what opening a conversation was asked for. */
  function anAgent(connectedIn: string | undefined) {
    const asked: { body?: unknown } = {}
    server.use(
      ...theSpace({
        machines: [
          {
            id: 'm-1',
            name: 'mina-mbp',
            ownerName: 'Mina',
            yours: true,
            ...(connectedIn === undefined ? {} : { connectedIn }),
            presence: { state: 'here' },
            agents: [{ kind: 'claude-code', name: 'Scout', version: '2.1.4', models: [] }],
          },
        ],
      }),
      http.post('*/spaces/acme/conversations', async ({ request }) => {
        asked.body = await request.json()
        return HttpResponse.json({ id: WHERE }, { status: 201 })
      }),
      http.get(`*/spaces/acme/conversations/${WHERE}`, () =>
        HttpResponse.json({
          id: WHERE,
          agentKind: 'claude-code',
          machineName: 'mina-mbp',
          working: { state: 'idle' },
          offers: [],
          messages: [],
        }),
      ),
    )

    return asked
  }

  /** On that agent's own screen, with something typed and nothing chosen. */
  async function typedToIt(): Promise<void> {
    open('/s/acme/a/m-1/claude-code')
    await screen.findByRole('heading', { name: 'How can Scout help?' })
    await userEvent.type(screen.getByRole('textbox', { name: 'Message Scout' }), 'Read notes.txt')
  }

  it('works in a folder of its own unless somebody says otherwise', async () => {
    const asked = anAgent('/Users/mina/code/thing')
    await typedToIt()

    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(asked.body).toMatchObject({ machineId: 'm-1' })
    })
    expect(asked.body).not.toHaveProperty('worksIn')
  })

  it('works in the machine\u2019s own directory when that is what was picked', async () => {
    // `03` promised an agent works in your files. `07` gives every conversation a folder of its
    // own so several can run at once, which would have ended that promise quietly — an empty
    // folder cannot answer "read src/payment". The promise survives as this choice, so a control
    // that did not reach the wire would be the promise gone with a control standing in for it.
    const asked = anAgent('/Users/mina/code/thing')
    await typedToIt()

    await userEvent.click(screen.getByRole('button', { name: 'Where it works: Its own folder' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'code/thing' }))
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(asked.body).toMatchObject({ worksIn: '/Users/mina/code/thing' })
    })
  })

  it('offers no choice from a machine too old to say where it was connected', async () => {
    // Nothing rather than a menu with one option in it, or a path this deployment guessed. Its
    // own folder is what happens, and it is what would have happened anyway.
    anAgent(undefined)
    await typedToIt()

    expect(screen.queryByRole('button', { name: /where it works/iu })).toBeNull()
  })

  it('creates the conversation with the first message only when it is sent', async () => {
    const id = '250d79d8-a888-4c71-9eac-79f56bafd195'
    let opened: unknown
    let continued: unknown
    server.use(
      ...theSpace({
        machines: [
          {
            id: 'm-1',
            name: 'mina-mbp',
            ownerName: 'Mina',
            yours: true,
            presence: { state: 'here' },
            agents: [
              {
                kind: 'claude-code',
                name: 'Scout',
                version: '2.1.4',
                models: [
                  {
                    id: 'sonnet',
                    name: 'Sonnet',
                    about: 'Fast and capable',
                    efforts: ['low', 'high'],
                    defaultEffort: 'low',
                    isDefault: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
      http.post('*/spaces/acme/conversations', async ({ request }) => {
        opened = await request.json()
        return HttpResponse.json({ id }, { status: 201 })
      }),
      http.post(`*/spaces/acme/conversations/${id}/messages`, async ({ request }) => {
        continued = await request.json()
        const body = continued as { asked: { text: string; model?: string; effort?: string } }
        return HttpResponse.json({
          id,
          agentKind: 'claude-code',
          machineName: 'mina-mbp',
          working: { state: 'idle' },
          offers: [],
          messages: [
            {
              seq: 2,
              at: new Date().toISOString(),
              role: 'user',
              said: null,
              content: body.asked,
            },
          ],
        })
      }),
      http.get(`*/spaces/acme/conversations/${id}`, ({ request }) =>
        HttpResponse.json({
          id,
          agentKind: 'claude-code',
          machineName: 'mina-mbp',
          working: { state: 'idle' },
          offers: [
            {
              id: 'sonnet',
              name: 'Sonnet',
              about: 'Fast and capable',
              efforts: ['low', 'high'],
              defaultEffort: 'low',
              isDefault: true,
            },
          ],
          messages: new URL(request.url).searchParams.has('after')
            ? []
            : [
                {
                  seq: 1,
                  at: new Date().toISOString(),
                  role: 'user',
                  content: { text: 'Read notes.txt' },
                },
              ],
        }),
      ),
    )
    const router = open('/s/acme')
    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    await userEvent.click(within(sidebar).getByRole('button', { name: 'Chat' }))
    await userEvent.click(
      within(sidebar).getByRole('link', { name: /Scout, Claude Code on mina-mbp, ready/i }),
    )

    await userEvent.type(screen.getByRole('textbox', { name: 'Message Scout' }), 'Read notes.txt')
    await userEvent.click(screen.getByRole('button', { name: 'Model: Auto' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Sonnet' }))
    await userEvent.click(screen.getByRole('button', { name: 'Thinking: Default' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/s/acme/c/${id}`)
    })
    expect(opened).toMatchObject({
      machineId: 'm-1',
      agentKind: 'claude-code',
      asked: { text: 'Read notes.txt', model: 'sonnet', effort: 'high' },
    })
    expect(opened).toHaveProperty('id')
    const firstMessage = await within(screen.getByRole('log')).findByText('Read notes.txt')
    expect(firstMessage.closest('.chat-line-person')?.getAttribute('data-entering')).toBe('true')

    await userEvent.type(screen.getByRole('textbox', { name: 'Message Scout' }), 'And summarize')
    await userEvent.click(screen.getByRole('button', { name: 'Model: Auto' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Sonnet' }))
    await userEvent.click(screen.getByRole('button', { name: 'Thinking: Default' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(continued).toMatchObject({
        asked: { text: 'And summarize', model: 'sonnet', effort: 'high' },
      })
    })
    expect(continued).toHaveProperty('key')
    expect(continued).toHaveProperty('after', 1)
    expect(within(screen.getByRole('log')).getByText('And summarize')).toBeTruthy()
  })

  it('opens an empty Workspace Settings shell', async () => {
    server.use(
      ...theSpace(),
      http.get('*/spaces/acme/members', () =>
        HttpResponse.json({
          members: [
            {
              userId: 'u-1',
              displayName: 'Mina',
              avatarUrl: '/avatars/users/u-1',
              role: 'owner',
              since: new Date().toISOString(),
              you: true,
            },
          ],
        }),
      ),
    )
    const router = open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    const trigger = within(sidebar).getByRole('button', { name: /Acme/i })
    await userEvent.click(trigger)

    const menu = await screen.findByRole('dialog', { name: /Acme menu/i })
    expect(within(menu).getByRole('button', { name: /change space emoji/i })).toBeDefined()
    expect(within(menu).queryByRole('button', { name: /invite members/i })).toBeNull()
    await userEvent.click(within(menu).getByRole('button', { name: 'Settings' }))

    const settings = await screen.findByRole('dialog', { name: 'Acme settings' })
    const [settingsSidebar, settingsContent] = [...(settings.firstElementChild?.children ?? [])]
    expect(screen.queryByRole('dialog', { name: /Acme menu/i })).toBeNull()
    expect(settingsSidebar?.textContent).toBe('')
    expect(settingsContent?.textContent).toBe('')
    expect(within(settings).queryByRole('heading')).toBeNull()
    expect(router.state.location.pathname).toBe('/s/acme')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Acme settings' })).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    await userEvent.click(trigger)
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: /Acme menu/i })).getByRole('button', {
        name: 'Settings',
      }),
    )
    const reopened = await screen.findByRole('dialog', { name: 'Acme settings' })
    const underlay = reopened.parentElement?.firstElementChild
    expect(underlay).not.toBeNull()
    await userEvent.click(underlay as HTMLElement)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Acme settings' })).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('collapses, reopens, and resizes from the keyboard', async () => {
    server.use(...theSpace())
    open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    const separator = screen.getByRole('separator')
    separator.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(separator.getAttribute('aria-valuenow')).toBe('278')

    await userEvent.click(within(sidebar).getByRole('button', { name: /close sidebar/i }))
    const reopen = await screen.findByRole('button', { name: /open sidebar/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(reopen)
    })

    await userEvent.click(reopen)
    const reopened = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(reopened).getByRole('button', { name: /close sidebar/i }),
      )
    })
  })

  it('does not call a Space it could not read a Space you do not have', async () => {
    // A read that failed is not a Space that is missing. Told "not available", somebody goes
    // looking for a Space that is theirs and is there, over a moment of no network.
    // A server that answered with a refusal body, which is the shape this took in production and
    // the one the query treated as success: `data` is undefined either way, and `?? null` turned
    // "could not read" into "not yours".
    server.use(
      signedIn(),
      http.get('*/spaces/acme', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'retry-later' }, { status: 503 }),
      ),
    )
    open('/s/acme')

    expect(await screen.findByText(/could not read this space/i)).toBeDefined()
    expect(screen.queryByText(/not available/i)).toBeNull()
  })

  it('says the same about a connection that never landed', async () => {
    server.use(
      signedIn(),
      http.get('*/spaces/acme', () => HttpResponse.error()),
    )
    open('/s/acme')

    expect(await screen.findByText(/could not read this space/i)).toBeDefined()
  })

  it('keeps the frame across screens, so a sidebar somebody moved stays moved', async () => {
    // The frame is a layout, mounted once. Mounted per screen, moving to the Inbox puts a new one
    // in its place and the sidebar somebody collapsed is open again.
    server.use(
      ...theSpace({ conversations: [] }),
      http.get('*/me/inbox', () => HttpResponse.json({ waiting: [] })),
    )
    const router = open('/s/acme')

    const sidebar = await screen.findByRole('complementary', { name: /Acme sidebar/i })
    await userEvent.click(within(sidebar).getByRole('button', { name: /close sidebar/i }))
    await screen.findByRole('button', { name: /open sidebar/i })

    await router.navigate({ to: '/s/$slug/inbox', params: { slug: 'acme' } })

    // Still collapsed: the same frame, with something else inside it.
    expect(await screen.findByRole('button', { name: /open sidebar/i })).toBeDefined()
  })

  it('asks somebody whose session ran out to sign in, and remembers where they were', async () => {
    // Being asked to sign in must not cost the address somebody came for — `prd.md` 01 calls
    // that the difference between an interruption and a loss.
    server.use(
      http.get('*/me', () => new HttpResponse(null, { status: 401 })),
      waysIn(),
    )
    const router = open('/s/acme')

    await screen.findByRole('form', { name: /^sign in$/i })

    expect(router.state.location.pathname).toBe('/sign-in')
    expect(router.state.location.search).toMatchObject({ next: '/s/acme' })
  })

  it('answers one that is not yours the same as one that is not there', async () => {
    server.use(
      // First, so it answers instead of the one the Space double carries.
      http.get('*/spaces/:slug', () =>
        HttpResponse.json({ reason: 'unavailable', recovery: 'start-over' }, { status: 404 }),
      ),
      ...theSpace({ slug: 'somebody-elses' }),
    )
    open('/s/somebody-elses')

    // Telling them apart would make the address bar a way to find out what exists.
    expect(await screen.findByText(/this space is not available/i)).toBeDefined()
  })
})
