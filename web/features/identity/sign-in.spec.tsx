import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { renderAt, server } from '../../../vitest.web-harness.tsx'
import { SignIn } from './sign-in.tsx'

const SCREENS = [
  { path: '/sign-in', render: () => <SignIn /> },
  { path: '/sign-in/code', render: () => <p>code screen</p> },
]

function offering(...providers: string[]) {
  return http.get('*/auth/ways-in', () =>
    HttpResponse.json({ offered: ['email-code', ...providers] }),
  )
}

const CHALLENGE = '11111111-1111-4111-8111-111111111111'

function asked(): { readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  server.use(
    http.post('*/auth/email/challenges', async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json(
        { challengeId: '11111111-1111-4111-8111-111111111111' },
        { status: 201 },
      )
    }),
  )
  return { bodies }
}

describe('choosing a way in', () => {
  it('says one address is one account before anything is chosen', async () => {
    server.use(offering('google'))
    renderAt('/sign-in', SCREENS)

    const said = await screen.findByText(/the same address reaches the same account/i)
    const google = await screen.findByRole('button', { name: /continue with google/i })

    // Whether somebody dares click a different button than last time is decided by reading this
    // first. After the choice it is the same as not saying it.
    expect(said.compareDocumentPosition(google)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('offers only what this deployment has keys for', async () => {
    server.use(offering('google'))
    renderAt('/sign-in', SCREENS)

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /continue with github/i })).toBeNull()
  })

  it('offers no provider at all when there are none', async () => {
    server.use(offering())
    renderAt('/sign-in', SCREENS)

    await screen.findByLabelText(/email address/i)
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull()
  })

  it('asks for a code and moves to the screen that takes it', async () => {
    server.use(offering())
    const sent = asked()
    renderAt('/sign-in', SCREENS)

    await userEvent.type(await screen.findByLabelText(/email address/i), 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: /send a code/i }))

    await screen.findByText('code screen')
    expect(sent.bodies[0]).toMatchObject({ email: 'mina@example.com' })
  })

  it('reuses one key across a retry, so one intention is never two mails', async () => {
    const bodies: Record<string, unknown>[] = []
    let attempt = 0
    server.use(
      offering(),
      http.post('*/auth/email/challenges', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>)
        attempt += 1
        // The first answer never arrives. This is the case the key exists for.
        if (attempt === 1) return HttpResponse.error()
        return HttpResponse.json({ challengeId: CHALLENGE }, { status: 201 })
      }),
    )
    renderAt('/sign-in', SCREENS)

    const field = await screen.findByLabelText(/email address/i)
    await userEvent.type(field, 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: /send a code/i }))
    await waitFor(() => {
      expect(bodies).toHaveLength(1)
    })

    await userEvent.click(screen.getByRole('button', { name: /send a code/i }))
    await screen.findByText('code screen')

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.['requestKey']).toBe(bodies[1]?.['requestKey'])
  })

  it('says what to do when a code went out moments ago', async () => {
    server.use(
      offering(),
      http.post('*/auth/email/challenges', () =>
        HttpResponse.json({ reason: 'too-soon', recovery: 'wait' }, { status: 429 }),
      ),
    )
    renderAt('/sign-in', SCREENS)

    await userEvent.type(await screen.findByLabelText(/email address/i), 'mina@example.com')
    await userEvent.click(screen.getByRole('button', { name: /send a code/i }))

    expect(await screen.findByText(/a code just went out/i)).toBeDefined()
  })
})
