import { sql } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { hashCode, RESEND_INTERVAL_SECONDS, verifyChallenge } from '../identity/emailed-code.ts'
import { connect, type Database } from './connection.ts'
import { openChallenge, type OpenedChallenge } from './email-challenge.ts'

const db: Database = connect(loadEnv())
const EMAIL = 'mina@example.com'
const SECRET = 's'.repeat(32)
const CODE = '493018'
const HASH = hashCode(EMAIL, CODE, SECRET)

afterAll(async () => {
  await db.destroy()
})

async function ask(requestKey: string, email = EMAIL, codeHash = HASH): Promise<OpenedChallenge> {
  return openChallenge(db, { requestKey, email, codeHash })
}

/** Moves a challenge back in time, so a test can reach past the resend interval without waiting. */
async function age(email: string, seconds: number): Promise<void> {
  await db
    .updateTable('email_challenges')
    .set({ created_at: sql`created_at - make_interval(secs => ${seconds})` })
    .where('email', '=', email)
    .execute()
}

async function challengeRow(id: string) {
  return db
    .selectFrom('email_challenges')
    .select(['code_hash', 'expires_at', 'attempts', 'closed_reason'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

async function count(): Promise<number> {
  return (await db.selectFrom('email_challenges').select('id').execute()).length
}

describe('openChallenge', () => {
  it('opens a challenge that has not been asked for before', async () => {
    expect(await ask('k1')).toMatchObject({ kind: 'opened' })
    expect(await count()).toBe(1)
  })

  it('gives the same challenge back for a repeated request key, so no second mail goes out', async () => {
    const first = await ask('k1')
    const second = await ask('k1')

    expect(second).toEqual({ kind: 'replayed', id: (first as { id: string }).id })
    expect(await count()).toBe(1)
  })

  it('hands back a challenge that still works, not one the retry itself closed', async () => {
    const first = await ask('k1')
    await ask('k1')

    // The person is holding the mail this challenge sent. Closing it on the way to returning it
    // would make their code read as expired the moment they typed it.
    expect((await challengeRow((first as { id: string }).id)).closed_reason).toBeNull()
  })

  it('opens exactly one when the same request key arrives twice at once', async () => {
    const [a, b] = await Promise.all([ask('k1'), ask('k1')])

    expect([a.kind, b.kind].sort()).toEqual(['opened', 'replayed'])
    expect(await count()).toBe(1)
  })

  it('refuses a second code while the first one is still fresh', async () => {
    await ask('k1')

    const again = await ask('k2')

    expect(again.kind).toBe('too-soon')
    if (again.kind !== 'too-soon') return
    expect(again.retryAfterSeconds).toBeGreaterThan(0)
    expect(again.retryAfterSeconds).toBeLessThanOrEqual(RESEND_INTERVAL_SECONDS)
    expect(await count()).toBe(1)
  })

  it('counts the wait down rather than restarting it', async () => {
    await ask('k1')
    await age(EMAIL, 20)

    const again = await ask('k2')

    expect(again).toMatchObject({
      kind: 'too-soon',
      retryAfterSeconds: RESEND_INTERVAL_SECONDS - 20,
    })
  })

  it('sends another once the wait is over', async () => {
    await ask('k1')
    await age(EMAIL, RESEND_INTERVAL_SECONDS)

    expect((await ask('k2')).kind).toBe('opened')
    expect(await count()).toBe(2)
  })

  it('still answers a repeated request key during the wait, instead of telling it to wait', async () => {
    const first = await ask('k1')

    // A browser retrying a lost response is not somebody clicking resend, and must not be told to
    // wait for a code it is already holding.
    expect(await ask('k1')).toEqual({ kind: 'replayed', id: (first as { id: string }).id })
  })

  it('lets a different address have its own code', async () => {
    await ask('k1')

    expect((await ask('k2', 'other@example.com')).kind).toBe('opened')
  })

  it('answers every one of many simultaneous asks for one address', async () => {
    // Two in flight is not enough to collide: they interleave and pass whether or not the
    // transaction serialises. Twenty makes the contention certain, and without the advisory lock
    // several get past the wait check together and die on the partial unique index.
    const asks = Array.from({ length: 20 }, async (_, index) => ask(`k${String(index)}`))

    const answers = await Promise.all(asks)

    expect(answers.filter((answer) => answer.kind === 'opened')).toHaveLength(1)
    expect(answers.filter((answer) => answer.kind === 'too-soon')).toHaveLength(19)
    expect(await count()).toBe(1)
  })

  it('closes the previous challenge, so only the newest code works', async () => {
    const old = await ask('k1')
    await age(EMAIL, RESEND_INTERVAL_SECONDS)
    await ask('k2', EMAIL, hashCode(EMAIL, '111111', SECRET))

    expect((await challengeRow((old as { id: string }).id)).closed_reason).toBe('superseded')
  })

  it('reports the replaced code as expired, not as wrong', async () => {
    const old = await ask('k1')
    await age(EMAIL, RESEND_INTERVAL_SECONDS)
    await ask('k2', EMAIL, hashCode(EMAIL, '111111', SECRET))

    const row = await challengeRow((old as { id: string }).id)
    const verdict = verifyChallenge(
      {
        email: EMAIL,
        codeHash: row.code_hash,
        expiresAt: row.expires_at,
        attempts: row.attempts,
        closedReason: row.closed_reason as 'consumed' | 'superseded' | null,
      },
      // The digits the person types are still the right ones for that old code.
      CODE,
      SECRET,
      new Date(),
    )

    expect(verdict).toEqual({ kind: 'rejected', rejection: 'expired' })
  })

  it('takes its expiry from the database clock, not from the caller', async () => {
    const opened = await ask('k1')

    const row = await challengeRow((opened as { id: string }).id)
    const minutesAway = (row.expires_at.getTime() - Date.now()) / 60_000

    expect(minutesAway).toBeGreaterThan(4)
    expect(minutesAway).toBeLessThan(6)
  })
})
