import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseEnv } from './env.ts'
import { resend } from './mail.ts'

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

const env = parseEnv({
  DATABASE_URL: 'postgres://a:b@localhost:5432/c',
  AUTH_SECRET: 's'.repeat(32),
  RESEND_API_KEY: 're_test_key',
  MAIL_FROM: 'from@example.com',
})

const LETTER = { to: 'mina@example.com', subject: 'Your code', text: '493018' }

const answering = (status: number) =>
  http.post('https://api.resend.com/emails', () => new HttpResponse(null, { status }))

describe('handing a letter to the provider', () => {
  it('says sent when it was taken', async () => {
    server.use(answering(200))

    expect(await resend(env)(LETTER)).toBe('sent')
  })

  it('carries the key and the sender it was configured with', async () => {
    let seen: { auth: string | null; body: unknown } = { auth: null, body: null }
    server.use(
      http.post('https://api.resend.com/emails', async ({ request }) => {
        seen = { auth: request.headers.get('authorization'), body: await request.json() }
        return new HttpResponse(null, { status: 200 })
      }),
    )

    await resend(env)(LETTER)

    expect(seen.auth).toBe('Bearer re_test_key')
    expect(seen.body).toEqual({ from: 'from@example.com', ...LETTER })
  })

  it('says refused when the provider said no, because it definitely did not go', async () => {
    server.use(answering(422))

    expect(await resend(env)(LETTER)).toBe('refused')
  })

  it('says unknown when their side broke after taking it', async () => {
    server.use(answering(500))

    // It may have gone out. Guessing either way would be a claim nobody can stand behind.
    expect(await resend(env)(LETTER)).toBe('unknown')
  })

  it('says unknown when the network never carried it', async () => {
    server.use(http.post('https://api.resend.com/emails', () => HttpResponse.error()))

    expect(await resend(env)(LETTER)).toBe('unknown')
  })

  it('never throws, so a letter that failed cannot take down a challenge that works', async () => {
    server.use(http.post('https://api.resend.com/emails', () => HttpResponse.error()))

    // The challenge is committed before this runs. Throwing here would fail a request whose real
    // work already succeeded.
    await expect(resend(env)(LETTER)).resolves.toBe('unknown')
  })
})
