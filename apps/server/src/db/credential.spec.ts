import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { newSessionToken } from '../identity/session.ts'
import { hashCode } from '../identity/email-code.ts'
import type { ProviderIdentity } from '../identity/provider.ts'
import { CREDENTIAL_KINDS } from '../identity/credential.ts'
import { addAddress, connectProvider } from './credential.ts'
import { issueCode } from './email-code.ts'
import { signInWithCode, signInWithProvider } from './sign-in.ts'
import { personById } from './user.ts'
import { connect, type Database } from './connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

const CODE = '493018'

/**
 * One fresh id per test, and everything the test touches is named from it. That is what lets a
 * count below be a count of this test's rows rather than of the whole table.
 */
let RUN = ''
let EMAIL = ''
let SUBJECT = ''

beforeEach(() => {
  RUN = randomUUID()
  EMAIL = `mina-${RUN}@example.com`
  // The provider's id has to be fresh too: two tests sharing one would be sharing an account.
  SUBJECT = `google-${RUN}`
})

function google(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    provider: 'google',
    subject: SUBJECT,
    verifiedEmail: EMAIL,
    name: 'Mina Kim',
    username: null,
    ...overrides,
  }
}

async function arrive(identity: ProviderIdentity) {
  return signInWithProvider(db, identity, newSessionToken().hash)
}

/** Opens a code and hands the code straight back, the way the other half of the product does. */
async function sendCode(email: string, requestKey: string, purpose: 'sign-in' | 'attach') {
  const opened = await issueCode(db, {
    requestKey,
    email,
    purpose,
    codeHash: hashCode(email, CODE, env.AUTH_SECRET),
  })
  if (opened.kind !== 'issued') throw new Error('the fixture asked for codes too fast')
  return opened.id
}

async function arriveByCode(email: string, requestKey: string): Promise<string> {
  const result = await signInWithCode(db, env.AUTH_SECRET, {
    codeId: await sendCode(email, requestKey, 'sign-in'),
    submittedCode: CODE,
    sessionTokenHash: newSessionToken().hash,
  })
  if (result.kind !== 'signed-in') throw new Error('the fixture could not sign in')
  return result.userId
}

async function attach(userId: string, email: string, requestKey: string) {
  return addAddress(db, env.AUTH_SECRET, userId, {
    codeId: await sendCode(email, requestKey, 'attach'),
    code: CODE,
  })
}

/** This test's people. The table holds everybody else's too, and always will. */
async function people(): Promise<number> {
  const rows = await db
    .selectFrom('credentials')
    .select('user_id')
    .where('subject', 'like', `%${RUN}%`)
    .where('kind', '=', 'email')
    .execute()
  return new Set(rows.map((row) => row.user_id)).size
}

async function opensWith(userId: string): Promise<readonly string[]> {
  const person = await personById(db, userId)
  return person.credentials.map((held) => `${held.kind}:${held.subject}`)
}

describe('arriving through a provider', () => {
  it('makes the account, and takes the name the provider gave', async () => {
    const arrived = await arrive(google())

    expect(arrived.merged).toBe(false)
    expect(await personById(db, arrived.userId)).toMatchObject({ displayName: 'Mina Kim' })
    expect(await opensWith(arrived.userId)).toEqual([`email:${EMAIL}`, `google:${SUBJECT}`])
  })

  it('comes back to the same account, and does not say it merged anything', async () => {
    const first = await arrive(google())
    const second = await arrive(google())

    expect(second.userId).toBe(first.userId)
    expect(second.merged).toBe(false)
    expect(await people()).toBe(1)
  })

  it('follows the account when the address over there changes', async () => {
    const first = await arrive(google())

    // Same person at Google, new address on their side. The subject is what the key is made of.
    const second = await arrive(google({ verifiedEmail: `mina.kim-${RUN}@example.com` }))

    expect(second.userId).toBe(first.userId)
    expect(await people()).toBe(1)
  })

  it('joins an account the address already opened, and says so once', async () => {
    const byCode = await arriveByCode(EMAIL, `${RUN}-k1`)

    const arrived = await arrive(google())

    expect(arrived.userId).toBe(byCode)
    // The one moment worth telling somebody about: their Google now opens an account they made
    // another way. The key goes on once, so this answer is the once.
    expect(arrived.merged).toBe(true)
    expect(await people()).toBe(1)
  })

  it('says it only that once', async () => {
    await arriveByCode(EMAIL, `${RUN}-k1`)
    await arrive(google())

    expect((await arrive(google())).merged).toBe(false)
  })

  it('lets a code sign in afterwards, into the same account', async () => {
    const arrived = await arrive(google())

    expect(await arriveByCode(EMAIL, `${RUN}-k1`)).toBe(arrived.userId)
    expect(await people()).toBe(1)
  })

  it('makes one account when the same person arrives twice at once', async () => {
    const [a, b] = await Promise.all([arrive(google()), arrive(google())])

    expect(a.userId).toBe(b.userId)
    expect(await people()).toBe(1)
  })

  it('makes one account when two providers prove the same address at once', async () => {
    // Neither finds anything, so both would make an account and the address would have decided
    // nothing. Only the lock stops that, because the `users` row has to exist before the key that
    // would collide can be written.
    const [a, b] = await Promise.all([
      arrive(google()),
      arrive({ ...google(), provider: 'github', subject: `github-${RUN}` }),
    ])

    expect(a.userId).toBe(b.userId)
    expect(await people()).toBe(1)
  })
})

describe('connecting a provider while signed in', () => {
  it('adds another way in', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)

    expect(await connectProvider(db, userId, google())).toEqual({ kind: 'connected' })
    expect(await opensWith(userId)).toContain(`google:${SUBJECT}`)
  })

  it('does nothing the second time, rather than refusing', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    await connectProvider(db, userId, google())

    expect(await connectProvider(db, userId, google())).toEqual({ kind: 'connected' })
  })

  it('takes one that proves a different address, because the session already proved the account', async () => {
    // The requirement that the addresses match was inherited from the days when the account *was*
    // an address. Whoever is signed in has proved they own this account, and is choosing to add a
    // way into it.
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)

    const elsewhere = google({ verifiedEmail: `else-${RUN}@example.com` })
    expect(await connectProvider(db, userId, elsewhere)).toEqual({ kind: 'connected' })
    expect(await opensWith(userId)).toEqual([`email:${EMAIL}`, `google:${SUBJECT}`])
  })

  it('does not quietly adopt the address that provider proved', async () => {
    // Adopting it would move an address off whatever account holds it, which is the whole of
    // account takeover. Wanting it here is a separate, deliberate act.
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    await connectProvider(db, userId, google({ verifiedEmail: `else-${RUN}@example.com` }))

    expect(await opensWith(userId)).not.toContain(`email:else-${RUN}@example.com`)
  })

  it('refuses one somebody else already reaches their account through', async () => {
    const mina = await arriveByCode(EMAIL, `${RUN}-k1`)
    const rui = await arriveByCode(`rui-${RUN}@example.com`, `${RUN}-k2`)
    await connectProvider(db, rui, google())

    const stolen = await connectProvider(db, mina, google())

    expect(stolen).toEqual({ kind: 'rejected', rejection: 'linked-elsewhere' })
    expect(await opensWith(mina)).toEqual([`email:${EMAIL}`])
  })

  it('refuses a second account at a provider it already reaches, rather than saying nothing', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    await connectProvider(db, userId, google())

    const second = await connectProvider(db, userId, google({ subject: `google2-${RUN}` }))

    expect(second).toEqual({ kind: 'rejected', rejection: 'already-connected' })
    expect(await opensWith(userId)).toEqual([`email:${EMAIL}`, `google:${SUBJECT}`])
  })
})

describe('adding an address while signed in', () => {
  it('makes it another way into the same account', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    const second = `zane-${RUN}@example.com`

    expect(await attach(userId, second, `${RUN}-k2`)).toEqual({ kind: 'attached' })
    expect(await opensWith(userId)).toEqual([`email:${EMAIL}`, `email:${second}`])
  })

  it('lets that address sign in on its own afterwards', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    const second = `zane-${RUN}@example.com`
    await attach(userId, second, `${RUN}-k2`)

    expect(await arriveByCode(second, `${RUN}-k3`)).toBe(userId)
  })

  it('is attached again rather than refused, because what was asked for is already true', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)

    expect(await attach(userId, EMAIL, `${RUN}-k2`)).toEqual({ kind: 'attached' })
  })

  it('refuses an address that opens somebody else, and moves nothing', async () => {
    const mina = await arriveByCode(EMAIL, `${RUN}-k1`)
    const ruiAddress = `rui-${RUN}@example.com`
    const rui = await arriveByCode(ruiAddress, `${RUN}-k2`)

    const taken = await attach(mina, ruiAddress, `${RUN}-k3`)

    expect(taken).toEqual({ kind: 'rejected', rejection: 'address-elsewhere' })
    expect(await opensWith(rui)).toEqual([`email:${ruiAddress}`])
    expect(await opensWith(mina)).toEqual([`email:${EMAIL}`])
  })

  it('refuses a wrong code without attaching anything', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    const second = `zane-${RUN}@example.com`

    const wrong = await addAddress(db, env.AUTH_SECRET, userId, {
      codeId: await sendCode(second, `${RUN}-k2`, 'attach'),
      code: '000000',
    })

    expect(wrong).toEqual({ kind: 'refused', rejection: 'code-mismatch' })
    expect(await opensWith(userId)).toEqual([`email:${EMAIL}`])
  })

  it('will not spend a code that was sent to sign in', async () => {
    // Two purposes, two letters. A code somebody was talked into forwarding cannot be turned into
    // a key on the forwarder's account.
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    const second = `zane-${RUN}@example.com`

    const crossed = await addAddress(db, env.AUTH_SECRET, userId, {
      codeId: await sendCode(second, `${RUN}-k2`, 'sign-in'),
      code: CODE,
    })

    expect(crossed).toEqual({ kind: 'refused', rejection: 'no-code' })
    expect(await opensWith(userId)).toEqual([`email:${EMAIL}`])
  })
})

describe('the kinds the database will accept', () => {
  /**
   * The constraint lives in SQL and the list lives in TypeScript, and no compiler crosses that
   * line. Comparing them directly catches a drift in either direction: a kind added to the code
   * without a migration, and one dropped from the code but still allowed by the database.
   */
  it('is exactly the list the code has', async () => {
    const constraint = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'credentials_kind_check'
    `.execute(db)

    const allowed = [...(constraint.rows[0]?.definition ?? '').matchAll(/'([a-z]+)'/gu)].map(
      (found) => found[1],
    )

    expect(new Set(allowed)).toEqual(new Set(CREDENTIAL_KINDS))
  })

  it('refuses a kind the code never has', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)

    const written = db
      .insertInto('credentials')
      .values({ user_id: userId, kind: 'myspace', subject: 's' })
      .execute()

    await expect(written).rejects.toThrow(/violates check constraint/iu)
  })
})
