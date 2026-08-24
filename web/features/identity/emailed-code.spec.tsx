import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { renderAt, server } from '../../../vitest.web-harness.tsx'
import { EmailedCode } from './emailed-code.tsx'

const EMAIL = 'mina@example.com'
const CHALLENGE = '11111111-1111-4111-8111-111111111111'

const SCREENS = [
  {
    path: '/sign-in/code',
    render: () => (
      <EmailedCode
        email={EMAIL}
        challengeId={CHALLENGE}
        expiresAt={new Date(Date.now() + 5 * 60_000).toISOString()}
        resendAfterSeconds={30}
      />
    ),
  },
  { path: '/sign-in', render: () => <p>sign-in screen</p> },
  { path: '/', render: () => <p>spaces screen</p> },
]

function refusing(reason: string, status: number) {
  return http.post('*/verify', () => HttpResponse.json({ reason, recovery: 'retype' }, { status }))
}

async function typeCode(digits: string): Promise<void> {
  await userEvent.type(await screen.findByLabelText(/six-digit code/i), digits)
}

describe('handing the code back', () => {
  it('submits on the sixth digit, with nothing to press', async () => {
    let handed = false
    server.use(
      http.post('*/verify', () => {
        handed = true
        return HttpResponse.json({ userId: CHALLENGE }, { status: 200 })
      }),
    )
    renderAt('/sign-in/code', SCREENS)

    await typeCode('493018')

    // Six digits and nothing left to decide.
    await waitFor(() => {
      expect(handed).toBe(true)
    })
    await screen.findByText('spaces screen')
  })

  it('does not submit before there are six', async () => {
    let handed = false
    server.use(
      http.post('*/verify', () => {
        handed = true
        return HttpResponse.json({ userId: CHALLENGE }, { status: 200 })
      }),
    )
    renderAt('/sign-in/code', SCREENS)

    await typeCode('49301')

    expect(handed).toBe(false)
  })

  it('says the address the code went to', async () => {
    renderAt('/sign-in/code', SCREENS)

    expect(await screen.findByText(EMAIL)).toBeDefined()
  })

  it('makes somebody wait before another code, and says how long', async () => {
    renderAt('/sign-in/code', SCREENS)

    const again = await screen.findByRole('button', { name: /send another in \d+s/i })

    expect(again.hasAttribute('disabled')).toBe(true)
  })

  it('carries the address back, so nobody retypes what they just typed', async () => {
    renderAt('/sign-in/code', SCREENS)

    const back = await screen.findByRole('link', { name: /use a different address/i })

    expect(back.getAttribute('href')).toContain(encodeURIComponent(EMAIL))
  })
})

describe('each way it can fail', () => {
  const said: readonly [string, number, RegExp][] = [
    ['code-mismatch', 400, /not right/i],
    ['expired', 409, /expired/i],
    ['consumed', 409, /already been used/i],
    ['attempts-exhausted', 429, /too many tries/i],
    ['no-challenge', 404, /no longer here/i],
  ]

  for (const [reason, status, words] of said) {
    it(`explains ${reason} in words about what to do`, async () => {
      server.use(refusing(reason, status))
      renderAt('/sign-in/code', SCREENS)

      await typeCode('000000')

      expect(await screen.findByText(words)).toBeDefined()
    })
  }

  it('never tells somebody a used code was simply wrong', async () => {
    server.use(refusing('consumed', 409))
    renderAt('/sign-in/code', SCREENS)

    await typeCode('000000')

    // Only one of these two means somebody else may have signed in with it.
    const shown = await screen.findByText(/already been used/i)
    expect(shown.textContent).not.toMatch(/not right/i)
  })
})
