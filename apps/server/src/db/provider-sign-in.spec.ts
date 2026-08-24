import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { newSessionToken } from '../identity/browser-session.ts'
import { hashCode } from '../identity/emailed-code.ts'
import { PROVIDERS, type ProviderIdentity } from '../identity/provider.ts'
import { openChallenge } from './email-challenge.ts'
import { connectProvider, signInWithProvider } from './provider-sign-in.ts'
import { signIn } from './sign-in.ts'
import { personById, personFor } from './user.ts'
import { connect, type Database } from './connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
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

let SUBJECT = ''

beforeEach(() => {
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

/** Signs somebody in with a code, the way the other half of the product does. */
async function arriveByCode(email: string, requestKey: string): Promise<string> {
  const opened = await openChallenge(db, {
    requestKey,
    email,
    codeHash: hashCode(email, CODE, env.AUTH_SECRET),
  })
  if (opened.kind !== 'opened') throw new Error('the fixture asked for codes too fast')

  const result = await signIn(db, env.AUTH_SECRET, {
    challengeId: opened.id,
    submittedCode: CODE,
    sessionTokenHash: newSessionToken().hash,
  })
  if (result.kind !== 'signed-in') throw new Error('the fixture could not sign in')
  return result.userId
}

/** This test's people. The table holds everybody else's too, and always will. */
async function people(): Promise<number> {
  const rows = await db
    .selectFrom('users')
    .select('id')
    .where('verified_email', 'like', `%${RUN}%`)
    .execute()
  return rows.length
}

describe('arriving through a provider', () => {
  it('makes the account, and takes the name the provider gave', async () => {
    const arrived = await arrive(google())

    expect(arrived.merged).toBe(false)
    expect(await personById(db, arrived.userId)).toMatchObject({
      displayName: 'Mina Kim',
      verifiedEmail: EMAIL,
      connected: ['google'],
    })
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

    // Same person at Google, new address on their side. The subject is what the link is made of.
    const second = await arrive(google({ verifiedEmail: `mina.kim-${RUN}@example.com` }))

    expect(second.userId).toBe(first.userId)
    expect(await people()).toBe(1)
  })

  it('joins an account the address already had, and says so once', async () => {
    const byCode = await arriveByCode(EMAIL, `${RUN}-k1`)

    const arrived = await arrive(google())

    expect(arrived.userId).toBe(byCode)
    // The one moment worth telling somebody about: their Google now reaches an account they made
    // another way. The link is made once, so this answer is the once.
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
})

describe('connecting a provider to an account already signed in', () => {
  it('adds a way in', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)

    expect(await connectProvider(db, userId, google())).toEqual({ kind: 'connected' })
    expect(await personById(db, userId)).toMatchObject({ connected: ['google'] })
  })

  it('does nothing the second time, rather than refusing', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)
    await connectProvider(db, userId, google())

    expect(await connectProvider(db, userId, google())).toEqual({ kind: 'connected' })
  })

  it('refuses one that proves a different address, and changes nothing', async () => {
    const userId = await arriveByCode(EMAIL, `${RUN}-k1`)

    const result = await connectProvider(
      db,
      userId,
      google({ verifiedEmail: `else-${RUN}@example.com` }),
    )

    expect(result).toEqual({ kind: 'rejected', rejection: 'email-mismatch' })
    expect(await personById(db, userId)).toMatchObject({ verifiedEmail: EMAIL, connected: [] })
  })

  it('refuses one that somebody else already reaches their account through', async () => {
    const mina = await arriveByCode(EMAIL, `${RUN}-k1`)
    const rui = await arriveByCode(`rui-${RUN}@example.com`, `${RUN}-k2`)
    await connectProvider(db, rui, google({ verifiedEmail: `rui-${RUN}@example.com` }))

    const stolen = await connectProvider(db, mina, google())

    expect(stolen).toEqual({ kind: 'rejected', rejection: 'linked-elsewhere' })
    expect(await personById(db, mina)).toMatchObject({ connected: [] })
  })
})

describe('the names the database will accept', () => {
  /**
   * The constraint lives in SQL and the list lives in TypeScript, and no compiler crosses that
   * line. Comparing them directly catches a drift in either direction: a provider added to the
   * code without a migration, and one dropped from the code but still allowed by the database.
   */
  it('is exactly the list the code offers', async () => {
    const constraint = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'sign_in_methods_kind_check'
    `.execute(db)

    const allowed = [...(constraint.rows[0]?.definition ?? '').matchAll(/'([a-z]+)'/gu)].map(
      (found) => found[1],
    )

    expect(new Set(allowed)).toEqual(new Set(PROVIDERS))
  })

  it('refuses a name the code never offers', async () => {
    const person = await personFor(db, { name: null, username: null, verifiedEmail: EMAIL })

    const written = db
      .insertInto('sign_in_methods')
      .values({ user_id: person, kind: 'myspace', subject: 's' })
      .execute()

    await expect(written).rejects.toThrow(/violates check constraint/iu)
  })
})
