import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { newSessionToken } from '../identity/session.ts'
import { hashCode, MAX_ATTEMPTS, RESEND_INTERVAL_SECONDS } from '../identity/email-code.ts'
import { issueCode } from './email-code.ts'
import { signInWithCode, type SignIn } from './sign-in.ts'
import { arrive } from './user.ts'
import { connect, type Database } from './connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()

/** Room enough that no test here trips the per-caller limit. */
const ROOM = 1000
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A fresh address per test, so no test depends on the database being empty when it starts. */
/** Request keys are unique across the whole table, so they have to be fresh per test too. */
let RUN = ''
let EMAIL = ''

beforeEach(() => {
  // One fresh id per test, and everything the test touches is named from it. That is what lets a
  // count below be a count of this test's rows rather than of the whole table.
  RUN = randomUUID()
  EMAIL = `mina-${RUN}@example.com`
})
const CODE = '493018'

async function sendCode(email = EMAIL, requestKey = `${RUN}-k1`): Promise<string> {
  const opened = await issueCode(
    db,
    {
      purpose: 'sign-in',
      requestKey,
      email,
      codeHash: hashCode(email, CODE, env.AUTH_SECRET),
      askedBy: null,
    },
    ROOM,
  )
  if (opened.kind !== 'issued') throw new Error(`the fixture could not get a code: ${opened.kind}`)
  return opened.id
}

async function submit(codeId: string, code = CODE): Promise<SignIn> {
  return signInWithCode(db, env.AUTH_SECRET, {
    codeId,
    submittedCode: code,
    sessionTokenHash: newSessionToken().hash,
  })
}

/** Moves a code back in time, so a test can reach past the resend interval without waiting. */
async function age(email: string): Promise<void> {
  await db
    .updateTable('email_codes')
    .set({ created_at: sql`created_at - make_interval(secs => ${RESEND_INTERVAL_SECONDS})` })
    .where('email', '=', email)
    .execute()
}

/** This test's people, counted through the keys that name them. */
async function people(): Promise<number> {
  const rows = await db
    .selectFrom('credentials')
    .select('user_id')
    .where('subject', 'like', `%${RUN}%`)
    .execute()
  return new Set(rows.map((row) => row.user_id)).size
}

/** Sessions belonging to this test's people. */
async function sessions(): Promise<number> {
  const rows = await db
    .selectFrom('browser_sessions')
    .innerJoin('credentials', 'credentials.user_id', 'browser_sessions.user_id')
    .select('browser_sessions.id')
    .where('credentials.subject', 'like', `%${RUN}%`)
    .execute()
  return rows.length
}

async function attemptsOn(codeId: string): Promise<number> {
  const row = await db
    .selectFrom('email_codes')
    .select('attempts')
    .where('id', '=', codeId)
    .executeTakeFirstOrThrow()
  return row.attempts
}

describe('signing in with a code', () => {
  it('creates the account on the first correct code, and a session with it', async () => {
    const result = await submit(await sendCode())

    expect(result.kind).toBe('signed-in')
    const keys = await db
      .selectFrom('credentials')
      .select(['kind', 'subject'])
      .where('subject', 'like', `%${RUN}%`)
      .execute()
    expect(keys).toEqual([{ kind: 'email', subject: EMAIL }])
    expect(await sessions()).toBe(1)
  })

  it('signs the same address back into the account it already has', async () => {
    const first = await submit(await sendCode(EMAIL, `${RUN}-k1`))
    const second = await submit(await sendCode(EMAIL, `${RUN}-k2`))

    expect(first.kind === 'signed-in' && second.kind === 'signed-in').toBe(true)
    expect(first).toMatchObject({ userId: (second as { userId: string }).userId })
    expect(await people()).toBe(1)
  })

  it('spends the code, so the same one cannot be used again', async () => {
    const codeId = await sendCode()
    await submit(codeId)

    expect(await submit(codeId)).toEqual({ kind: 'rejected', rejection: 'consumed' })
  })

  it('counts a wrong guess and leaves the code open', async () => {
    const codeId = await sendCode()

    expect(await submit(codeId, '000000')).toEqual({
      kind: 'rejected',
      rejection: 'code-mismatch',
    })
    expect(await attemptsOn(codeId)).toBe(1)
    expect((await submit(codeId)).kind).toBe('signed-in')
  })

  it('stops accepting guesses once the tries are gone', async () => {
    const codeId = await sendCode()
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await submit(codeId, '000000')

    // Even the right code, now: the code is finished, not the guess wrong.
    expect(await submit(codeId)).toEqual({
      kind: 'rejected',
      rejection: 'attempts-exhausted',
    })
  })

  it('does not spend a try on a code that was already over', async () => {
    const codeId = await sendCode()
    await submit(codeId)

    await submit(codeId, '000000')

    // Counting this would burn the tries of somebody being told the code is already used.
    expect(await attemptsOn(codeId)).toBe(0)
  })

  it('rejects a code a newer one replaced, and creates nobody', async () => {
    const stale = await sendCode(EMAIL, `${RUN}-k1`)
    await age(EMAIL)
    await sendCode(EMAIL, `${RUN}-k2`)

    expect(await submit(stale)).toEqual({ kind: 'rejected', rejection: 'expired' })
    expect(await people()).toBe(0)
  })

  it('rejects a code that is not there', async () => {
    const gone = '00000000-0000-0000-0000-000000000000'

    expect(await submit(gone)).toEqual({ kind: 'rejected', rejection: 'no-code' })
  })

  it('dates the session by the database clock', async () => {
    await submit(await sendCode())

    const session = await db
      .selectFrom('browser_sessions')
      .innerJoin('credentials', 'credentials.user_id', 'browser_sessions.user_id')
      .select('expires_at')
      .where('credentials.subject', 'like', `%${RUN}%`)
      .executeTakeFirstOrThrow()
    const daysAway = (session.expires_at.getTime() - Date.now()) / 86_400_000

    expect(daysAway).toBeGreaterThan(29)
    expect(daysAway).toBeLessThan(31)
  })
})

/** One arrival, in its own transaction, the way every caller in the product does it. */
async function arriveOnce() {
  return db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: EMAIL }, { name: null, username: null, address: EMAIL }),
    )
}

describe('twenty sign-ins racing to create the same person', () => {
  it('makes one account, and all of them end up in it', async () => {
    // Two was not enough to force contention; twenty is. Whoever loses has to find the winner's
    // account rather than fail: it is the same address, so it is the same person, and none of
    // them did anything wrong.
    const arrived = await Promise.all(Array.from({ length: 20 }, arriveOnce))

    expect(new Set(arrived.map((one) => one.userId)).size).toBe(1)
    expect(await people()).toBe(1)
  })
})
