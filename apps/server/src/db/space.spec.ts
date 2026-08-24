import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Slug } from '@handover/universal'
import { createSpace, type SpaceCreation } from './space.ts'
import { connect, type Database } from './connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A fresh name and key per test, so no test can see another's Spaces or reuse its requests. */
let ACME = 'acme' as Slug
let RUN = ''

beforeEach(() => {
  RUN = randomUUID()
  ACME = `acme-${RUN.slice(0, 8)}` as Slug
})

async function someone(label: string): Promise<string> {
  const email = `${label}-${randomUUID()}@example.com`
  const user = await db
    .insertInto('users')
    .values({ verified_email: email, display_name: email })
    .returning('id')
    .executeTakeFirstOrThrow()
  return user.id
}

async function request(userId: string, requestKey: string, slug: Slug): Promise<SpaceCreation> {
  return createSpace(db, { requestKey, userId, displayName: 'Acme', slug })
}

/** Only the names this test asked for: the table holds every other test's Spaces too. */
async function spaceCount(): Promise<number> {
  const rows = await db
    .selectFrom('spaces')
    .select('id')
    .where((eb) => eb.or([eb('slug', '=', ACME), eb('slug', 'like', `${ACME}-%`)]))
    .execute()
  return rows.length
}

describe('createSpace', () => {
  it('creates the Space and makes the requester a member', async () => {
    const userId = await someone('mina')

    const result = await request(userId, `${RUN}-k1`, ACME)

    expect(result.kind).toBe('created')
    const members = await db
      .selectFrom('memberships')
      .innerJoin('spaces', 'spaces.id', 'memberships.space_id')
      .select('user_id')
      .where('spaces.slug', '=', ACME)
      .execute()
    expect(members).toEqual([{ user_id: userId }])
  })

  it('gives the same Space back for a repeated request key', async () => {
    const userId = await someone('mina')

    const first = await request(userId, `${RUN}-k1`, ACME)
    const second = await request(userId, `${RUN}-k1`, ACME)

    expect(second.kind).toBe('replayed')
    expect(second).toMatchObject({ space: { slug: ACME } })
    expect(first).toMatchObject({ space: { slug: ACME } })
    expect(await spaceCount()).toBe(1)
  })

  it('tells a second person the name is taken, and what to try instead', async () => {
    const mina = await someone('mina')
    const rui = await someone('rui@example.com')

    await request(mina, `${RUN}-k1`, ACME)
    const result = await request(rui, `${RUN}-k2`, ACME)

    expect(result).toEqual({ kind: 'slug-taken', suggestion: `${ACME}-2` })
    expect(await spaceCount()).toBe(1)
  })

  it('counts past the suggestions that were already taken', async () => {
    const mina = await someone('mina')
    await request(mina, `${RUN}-k1`, ACME)
    await request(mina, `${RUN}-k2`, `${ACME}-2` as Slug)

    const result = await request(mina, `${RUN}-k3`, ACME)

    expect(result).toEqual({ kind: 'slug-taken', suggestion: `${ACME}-3` })
  })

  it('creates one Space when the same request key arrives many times at once', async () => {
    const userId = await someone('mina')

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => request(userId, `${RUN}-k1`, ACME)),
    )

    expect(await spaceCount()).toBe(1)
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'replayed')).toHaveLength(19)
    expect(await spaceCount()).toBe(1)
  })

  it('lets one of many racing for the same name win, and answers the rest', async () => {
    const userId = await someone('mina')

    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        request(userId, `${RUN}-k${String(index)}`, ACME),
      ),
    )

    expect(await spaceCount()).toBe(1)
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1)
    const rejected = results.filter((r) => r.kind === 'slug-taken')
    // The rest lose the race. Some lose it to the unique index and some to a replay of their own
    // key, so what matters is that exactly one made it and nobody got a second Space.
    expect(rejected.length + results.filter((r) => r.kind === 'replayed').length).toBe(19)
    expect(rejected.every((r) => r.suggestion === `${ACME}-2`)).toBe(true)
  })

  it('does not hold the suggestion it just gave out', async () => {
    const mina = await someone('mina')
    const rui = await someone('rui@example.com')
    await request(mina, `${RUN}-k1`, ACME)

    const offered = await request(rui, `${RUN}-k2`, ACME)
    expect(offered).toEqual({ kind: 'slug-taken', suggestion: `${ACME}-2` })

    // A third person can take it before the second gets around to submitting it.
    const zoe = await someone('zoe@example.com')
    expect((await request(zoe, `${RUN}-k3`, `${ACME}-2` as Slug)).kind).toBe('created')
    expect((await request(rui, `${RUN}-k4`, `${ACME}-2` as Slug)).kind).toBe('slug-taken')
  })
})
