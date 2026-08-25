import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashCode, RESEND_INTERVAL_SECONDS, checkCode } from '../identity/email-code.ts'
import { issueCode, noteDelivery, type Issued } from './email-code.ts'
import { connect, type Database } from './connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()

/** Room enough that no test here trips the per-caller limit. */
const ROOM = 1000
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

const SECRET = 's'.repeat(32)
const CODE = '493018'

/**
 * A fresh address per test. Nothing one test does is visible to another, so none of them needs
 * the database emptied first, and they can run alongside each other.
 */
/** Request keys are unique across the whole table, so they have to be fresh per test too. */
let RUN = ''
let EMAIL = ''
let HASH = ''

beforeEach(() => {
  RUN = randomUUID()
  EMAIL = `${randomUUID()}@example.com`
  HASH = hashCode(EMAIL, CODE, SECRET)
})

async function ask(requestKey: string, email = EMAIL, codeHash = HASH): Promise<Issued> {
  return issueCode(db, { purpose: 'sign-in', requestKey, email, codeHash, askedBy: null }, ROOM)
}

/** The three things that make a request that request. */
const asking = (requestKey: string) => ({ requestKey, email: EMAIL, purpose: 'sign-in' as const })

/** Makes an attempt look like one whose process died: committed, and nothing ever recorded. */
async function abandon(codeId: string): Promise<void> {
  await db
    .updateTable('email_codes')
    .set({ created_at: sql<Date>`now() - interval '1 minute'` })
    .where('id', '=', codeId)
    .execute()
}

/** Moves a code back in time, so a test can reach past the resend interval without waiting. */
async function age(email: string, seconds: number): Promise<void> {
  await db
    .updateTable('email_codes')
    .set({ created_at: sql`created_at - make_interval(secs => ${seconds})` })
    .where('email', '=', email)
    .execute()
}

async function codeRow(id: string) {
  return db
    .selectFrom('email_codes')
    .select(['code_hash', 'expires_at', 'attempts', 'closed_reason'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

/** Only this test's own address: counting the whole table would be counting other tests. */
async function count(): Promise<number> {
  const rows = await db.selectFrom('email_codes').select('id').where('email', '=', EMAIL).execute()
  return rows.length
}

describe('issueCode', () => {
  it('opens a code that has not been asked for before', async () => {
    expect(await ask(`${RUN}-k1`)).toMatchObject({ kind: 'issued' })
    expect(await count()).toBe(1)
  })

  it('gives the same code back for a repeated request key, so no second mail goes out', async () => {
    const first = await ask(`${RUN}-k1`)
    const second = await ask(`${RUN}-k1`)

    expect(second).toMatchObject({ kind: 'replayed', id: (first as { id: string }).id })
    expect(await count()).toBe(1)
  })

  it('hands back a code that still works, not one the retry itself closed', async () => {
    const first = await ask(`${RUN}-k1`)
    await ask(`${RUN}-k1`)

    // The person is holding the mail this code sent. Closing it on the way to returning it
    // would make their code read as expired the moment they typed it.
    expect((await codeRow((first as { id: string }).id)).closed_reason).toBeNull()
  })

  it('opens exactly one when the same request key arrives twice at once', async () => {
    const [a, b] = await Promise.all([ask(`${RUN}-k1`), ask(`${RUN}-k1`)])

    expect([a.kind, b.kind].sort()).toEqual(['issued', 'replayed'])
    expect(await count()).toBe(1)
  })

  it('refuses a second code while the first one is still fresh', async () => {
    await ask(`${RUN}-k1`)

    const again = await ask(`${RUN}-k2`)

    expect(again.kind).toBe('too-soon')
    if (again.kind !== 'too-soon') return
    expect(again.retryAfterSeconds).toBeGreaterThan(0)
    expect(again.retryAfterSeconds).toBeLessThanOrEqual(RESEND_INTERVAL_SECONDS)
    expect(await count()).toBe(1)
  })

  it('counts the wait down rather than restarting it', async () => {
    await ask(`${RUN}-k1`)
    await age(EMAIL, 20)

    const again = await ask(`${RUN}-k2`)

    expect(again).toMatchObject({
      kind: 'too-soon',
      retryAfterSeconds: RESEND_INTERVAL_SECONDS - 20,
    })
  })

  it('sends another once the wait is over', async () => {
    await ask(`${RUN}-k1`)
    await age(EMAIL, RESEND_INTERVAL_SECONDS)

    expect((await ask(`${RUN}-k2`)).kind).toBe('issued')
    expect(await count()).toBe(2)
  })

  it('still answers a repeated request key during the wait, instead of telling it to wait', async () => {
    const first = await ask(`${RUN}-k1`)

    // A browser retrying a lost response is not somebody clicking resend, and must not be told to
    // wait for a code it is already holding.
    expect(await ask(`${RUN}-k1`)).toMatchObject({
      kind: 'replayed',
      id: (first as { id: string }).id,
    })
  })

  it('lets a different address have its own code', async () => {
    await ask(`${RUN}-k1`)

    expect((await ask(`${RUN}-k2`, `other-${randomUUID()}@example.com`)).kind).toBe('issued')
  })

  it('answers every one of many simultaneous asks for one address', async () => {
    // Two in flight is not enough to collide: they interleave and pass whether or not the
    // transaction serialises. Twenty makes the contention certain, and without the advisory lock
    // several get past the wait check together and die on the partial unique index.
    const asks = Array.from({ length: 20 }, async (_, index) => ask(`${RUN}-k${String(index)}`))

    const answers = await Promise.all(asks)

    expect(answers.filter((answer) => answer.kind === 'issued')).toHaveLength(1)
    expect(answers.filter((answer) => answer.kind === 'too-soon')).toHaveLength(19)
    expect(await count()).toBe(1)
  })

  it('closes the previous code, so only the newest code works', async () => {
    const old = await ask(`${RUN}-k1`)
    await age(EMAIL, RESEND_INTERVAL_SECONDS)
    await ask(`${RUN}-k2`, EMAIL, hashCode(EMAIL, '111111', SECRET))

    expect((await codeRow((old as { id: string }).id)).closed_reason).toBe('superseded')
  })

  it('reports the replaced code as expired, not as wrong', async () => {
    const old = await ask(`${RUN}-k1`)
    await age(EMAIL, RESEND_INTERVAL_SECONDS)
    await ask(`${RUN}-k2`, EMAIL, hashCode(EMAIL, '111111', SECRET))

    const row = await codeRow((old as { id: string }).id)
    const verdict = checkCode(
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
    const opened = await ask(`${RUN}-k1`)

    const row = await codeRow((opened as { id: string }).id)
    const minutesAway = (row.expires_at.getTime() - Date.now()) / 60_000

    expect(minutesAway).toBeGreaterThan(4)
    expect(minutesAway).toBeLessThan(6)
  })

  it('says when it expires and when another may be asked for, so no page has to guess', async () => {
    const opened = await ask(`${RUN}-k1`)
    if (opened.kind !== 'issued') throw new Error(`unexpected: ${opened.kind}`)

    // A number compiled into a page is right until somebody changes this one and not that one.
    expect(opened.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(opened.resendAfterSeconds).toBe(RESEND_INTERVAL_SECONDS)
  })

  it('does not call a letter to another address the same request', async () => {
    // The key is the caller's own string. Matched on its own, the same key sent for a different
    // address hands back the first letter's id and expiry and says a code is on its way — to an
    // inbox nothing was ever sent to.
    const key = `${RUN}-shared`
    const first = await ask(key)

    const second = await ask(key, `other-${RUN}@example.com`)

    expect(first.kind).toBe('issued')
    expect(second.kind).toBe('issued')
    if (first.kind !== 'issued' || second.kind !== 'issued') throw new Error('both should issue')
    expect(second.id).not.toBe(first.id)
  })

  it('will not say a code is on its way to an address that refused the last one', async () => {
    // Left unrecorded, a refusal came back as "a code is on its way" on every retry — somebody
    // waiting for a letter that will never exist, told twice that it is coming.
    const key = `${RUN}-dead`
    const first = await ask(key)
    if (first.kind !== 'issued') throw new Error('expected a code')
    await noteDelivery(db, asking(key), 'refused')

    expect(await ask(key)).toEqual({ kind: 'undeliverable' })
  })

  it('hands back the same code when the letter went, rather than sending a second', async () => {
    const key = `${RUN}-sent`
    const first = await ask(key)
    if (first.kind !== 'issued') throw new Error('expected a code')
    await noteDelivery(db, asking(key), 'sent')

    expect(await ask(key)).toMatchObject({ kind: 'replayed', id: first.id })
  })

  it('hands back the same code when nobody can say whether the letter went', async () => {
    // It may be in the inbox. A second one would kill it, and the first is the one being read.
    const key = `${RUN}-maybe`
    const first = await ask(key)
    if (first.kind !== 'issued') throw new Error('expected a code')
    await noteDelivery(db, asking(key), 'unknown')

    expect(await ask(key)).toMatchObject({ kind: 'replayed', id: first.id })
  })

  it('mints a fresh code when the last attempt died without sending anything', async () => {
    // The one case this column exists for. The row was committed and the process died before the
    // letter went; nobody knows that code, including us — it only ever existed in memory.
    const key = `${RUN}-orphan`
    const first = await ask(key)
    if (first.kind !== 'issued') throw new Error('expected a code')
    await abandon(first.id)

    const second = await ask(key)

    expect(second.kind).toBe('issued')
    expect(second.kind === 'issued' && second.id).not.toBe(first.id)
  })

  it('stops one caller asking again and again, whatever address they use', async () => {
    // The per-address wait is no defence against rotating addresses, and every letter that gets
    // sent that way costs money and spends the sending domain's reputation.
    const caller = `caller-${RUN}`
    for (let n = 0; n < 3; n += 1) {
      const asked = await issueCode(
        db,
        {
          requestKey: `${RUN}-n${String(n)}`,
          email: `${RUN}-${String(n)}@example.com`,
          purpose: 'sign-in',
          codeHash: HASH,
          askedBy: caller,
        },
        3,
      )
      expect(asked.kind).toBe('issued')
    }

    const refused = await issueCode(
      db,
      {
        requestKey: `${RUN}-n4`,
        email: `${RUN}-4@example.com`,
        purpose: 'sign-in',
        codeHash: HASH,
        askedBy: caller,
      },
      3,
    )

    expect(refused.kind).toBe('too-many')
    // How long, rather than a number a page had to invent.
    expect(refused.kind === 'too-many' && refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('counts nobody when the deployment cannot tell who is calling', async () => {
    // Better than counting a number the caller chose. What guards the endpoint then is whatever
    // terminates TLS, which is the only thing that knows the address for certain.
    for (let n = 0; n < 4; n += 1) {
      const asked = await issueCode(
        db,
        {
          requestKey: `${RUN}-anon${String(n)}`,
          email: `${RUN}-anon${String(n)}@example.com`,
          purpose: 'sign-in',
          codeHash: HASH,
          askedBy: null,
        },
        3,
      )
      expect(asked.kind).toBe('issued')
    }
  })
})
