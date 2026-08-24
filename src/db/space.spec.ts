import { afterAll, describe, expect, it } from 'vitest'
import type { Slug } from '../space/slug.ts'
import { loadEnv } from '../env.ts'
import type { Database } from './connection.ts'
import { createSpace, type SpaceCreation } from './space.ts'
import { connect } from './connection.ts'

const db: Database = connect(loadEnv())
const ACME = 'acme' as Slug

afterAll(async () => {
  await db.destroy()
})

async function someone(email: string): Promise<string> {
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

async function spaceCount(): Promise<number> {
  return (await db.selectFrom('spaces').select('id').execute()).length
}

describe('createSpace', () => {
  it('creates the Space and makes the requester a member', async () => {
    const userId = await someone('mina@example.com')

    const result = await request(userId, 'k1', ACME)

    expect(result.kind).toBe('created')
    const members = await db.selectFrom('memberships').select('user_id').execute()
    expect(members).toEqual([{ user_id: userId }])
  })

  it('gives the same Space back for a repeated request key', async () => {
    const userId = await someone('mina@example.com')

    const first = await request(userId, 'k1', ACME)
    const second = await request(userId, 'k1', ACME)

    expect(second.kind).toBe('replayed')
    expect(second).toMatchObject({ space: { slug: 'acme' } })
    expect(first).toMatchObject({ space: { slug: 'acme' } })
    expect(await spaceCount()).toBe(1)
  })

  it('tells a second person the name is taken, and what to try instead', async () => {
    const mina = await someone('mina@example.com')
    const rui = await someone('rui@example.com')

    await request(mina, 'k1', ACME)
    const result = await request(rui, 'k2', ACME)

    expect(result).toEqual({ kind: 'slug-taken', suggestion: 'acme-2' })
    expect(await spaceCount()).toBe(1)
  })

  it('counts past the suggestions that were already taken', async () => {
    const mina = await someone('mina@example.com')
    await request(mina, 'k1', ACME)
    await request(mina, 'k2', 'acme-2' as Slug)

    const result = await request(mina, 'k3', ACME)

    expect(result).toEqual({ kind: 'slug-taken', suggestion: 'acme-3' })
  })

  it('creates one Space when the same request key arrives many times at once', async () => {
    const userId = await someone('mina@example.com')

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => request(userId, 'k1', ACME)),
    )

    expect(await spaceCount()).toBe(1)
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'replayed')).toHaveLength(19)
    expect((await db.selectFrom('memberships').select('user_id').execute()).length).toBe(1)
  })

  it('lets one of many racing for the same name win, and answers the rest', async () => {
    const userId = await someone('mina@example.com')

    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => request(userId, `k${String(index)}`, ACME)),
    )

    expect(await spaceCount()).toBe(1)
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1)
    const rejected = results.filter((r) => r.kind === 'slug-taken')
    expect(rejected).toHaveLength(19)
    expect(rejected.every((r) => r.suggestion === 'acme-2')).toBe(true)
  })

  it('does not hold the suggestion it just gave out', async () => {
    const mina = await someone('mina@example.com')
    const rui = await someone('rui@example.com')
    await request(mina, 'k1', ACME)

    const offered = await request(rui, 'k2', ACME)
    expect(offered).toEqual({ kind: 'slug-taken', suggestion: 'acme-2' })

    // A third person can take it before the second gets around to submitting it.
    const zoe = await someone('zoe@example.com')
    expect((await request(zoe, 'k3', 'acme-2' as Slug)).kind).toBe('created')
    expect((await request(rui, 'k4', 'acme-2' as Slug)).kind).toBe('slug-taken')
  })
})
