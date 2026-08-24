import { sql } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { newSessionToken } from '../identity/browser-session.ts'
import { hashCode, MAX_ATTEMPTS, RESEND_INTERVAL_SECONDS } from '../identity/emailed-code.ts'
import { loadEnv } from '../env.ts'
import { connect, type Database } from './connection.ts'
import { openChallenge } from './email-challenge.ts'
import { signIn, type SignIn } from './sign-in.ts'

const env = loadEnv()
const db: Database = connect(env)
const EMAIL = 'mina@example.com'
const CODE = '493018'

afterAll(async () => {
  await db.destroy()
})

async function sendCode(email = EMAIL, requestKey = 'k1'): Promise<string> {
  const opened = await openChallenge(db, {
    requestKey,
    email,
    codeHash: hashCode(email, CODE, env.AUTH_SECRET),
  })
  if (opened.kind === 'too-soon') throw new Error('the fixture asked for codes too fast')
  return opened.id
}

async function submit(challengeId: string, code = CODE): Promise<SignIn> {
  return signIn(db, env.AUTH_SECRET, {
    challengeId,
    submittedCode: code,
    sessionTokenHash: newSessionToken().hash,
  })
}

/** Moves a challenge back in time, so a test can reach past the resend interval without waiting. */
async function age(email: string): Promise<void> {
  await db
    .updateTable('email_challenges')
    .set({ created_at: sql`created_at - make_interval(secs => ${RESEND_INTERVAL_SECONDS})` })
    .where('email', '=', email)
    .execute()
}

async function attemptsOn(challengeId: string): Promise<number> {
  const row = await db
    .selectFrom('email_challenges')
    .select('attempts')
    .where('id', '=', challengeId)
    .executeTakeFirstOrThrow()
  return row.attempts
}

describe('signIn', () => {
  it('creates the account on the first correct code, and a session with it', async () => {
    const result = await submit(await sendCode())

    expect(result.kind).toBe('signed-in')
    const users = await db.selectFrom('users').select('verified_email').execute()
    expect(users).toEqual([{ verified_email: EMAIL }])
    expect((await db.selectFrom('browser_sessions').select('id').execute()).length).toBe(1)
  })

  it('signs the same address back into the account it already has', async () => {
    const first = await submit(await sendCode(EMAIL, 'k1'))
    const second = await submit(await sendCode(EMAIL, 'k2'))

    expect(first.kind === 'signed-in' && second.kind === 'signed-in').toBe(true)
    expect(first).toMatchObject({ userId: (second as { userId: string }).userId })
    expect((await db.selectFrom('users').select('id').execute()).length).toBe(1)
  })

  it('spends the code, so the same one cannot be used again', async () => {
    const challengeId = await sendCode()
    await submit(challengeId)

    expect(await submit(challengeId)).toEqual({ kind: 'rejected', rejection: 'consumed' })
  })

  it('counts a wrong guess and leaves the challenge open', async () => {
    const challengeId = await sendCode()

    expect(await submit(challengeId, '000000')).toEqual({
      kind: 'rejected',
      rejection: 'code-mismatch',
    })
    expect(await attemptsOn(challengeId)).toBe(1)
    expect((await submit(challengeId)).kind).toBe('signed-in')
  })

  it('stops accepting guesses once the tries are gone', async () => {
    const challengeId = await sendCode()
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await submit(challengeId, '000000')

    // Even the right code, now: the challenge is finished, not the guess wrong.
    expect(await submit(challengeId)).toEqual({
      kind: 'rejected',
      rejection: 'attempts-exhausted',
    })
  })

  it('does not spend a try on a challenge that was already over', async () => {
    const challengeId = await sendCode()
    await submit(challengeId)

    await submit(challengeId, '000000')

    // Counting this would burn the tries of somebody being told the code is already used.
    expect(await attemptsOn(challengeId)).toBe(0)
  })

  it('rejects a code a newer one replaced, and creates nobody', async () => {
    const stale = await sendCode(EMAIL, 'k1')
    await age(EMAIL)
    await sendCode(EMAIL, 'k2')

    expect(await submit(stale)).toEqual({ kind: 'rejected', rejection: 'expired' })
    expect(await db.selectFrom('users').select('id').execute()).toEqual([])
  })

  it('rejects a challenge that is not there', async () => {
    const gone = '00000000-0000-0000-0000-000000000000'

    expect(await submit(gone)).toEqual({ kind: 'rejected', rejection: 'no-challenge' })
  })

  it('dates the session by the database clock', async () => {
    await submit(await sendCode())

    const session = await db
      .selectFrom('browser_sessions')
      .select('expires_at')
      .executeTakeFirstOrThrow()
    const daysAway = (session.expires_at.getTime() - Date.now()) / 86_400_000

    expect(daysAway).toBeGreaterThan(29)
    expect(daysAway).toBeLessThan(31)
  })
})
