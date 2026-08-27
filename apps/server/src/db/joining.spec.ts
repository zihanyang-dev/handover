/**
 * More than one person in a Space.
 *
 * What is under test here is mostly *refusal*: a link that stopped working, a member who tries to
 * do an owner's job, and the one that can lock everybody out — the last owner leaving.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSlug, type Slug } from '@handover/universal'
import { loadEnv } from '../env.ts'
import { connect, type Database } from './connection.ts'
import {
  inviteInto,
  invitationsInto,
  joinWith,
  revokeInvitation,
  whatItOpens,
} from './invitation.ts'
import { becomes, isOwner, joins, membersOf, removes, ROLE, whatTheyHold } from './membership.ts'
import { createSpace, spaceForMember, spacesOf } from './space.ts'
import { arrive } from './user.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

let RUN = ''
let KAI = ''
let MINA = ''
let SPACE = ''
let SLUG = ''

beforeEach(async () => {
  RUN = randomUUID()
  KAI = await someone('kai')
  MINA = await someone('mina')

  const name = `Acme ${RUN.slice(0, 8)}`
  SLUG = normalizeSlug(name) as string
  const made = await createSpace(db, {
    requestKey: `space-${RUN}`,
    userId: KAI,
    displayName: name,
    slug: SLUG as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
  SPACE = made.space.id
})

async function someone(name: string): Promise<string> {
  const address = `${name}-${randomUUID()}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )

  return arrived.userId
}

async function invited(): Promise<string> {
  return (await inviteInto(db, { spaceId: SPACE, by: KAI })).secret
}

describe('whoever made a Space', () => {
  it('is its owner, so somebody can let the second person in', async () => {
    expect(await isOwner(db, SPACE, KAI)).toBe(true)
  })
})

describe('a link somebody follows', () => {
  it('lets the second person in, and they see the Space', async () => {
    const secret = await invited()
    const opens = await whatItOpens(db, secret)
    expect(opens).toMatchObject({ kind: 'open', slug: SLUG })

    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(await spaceForMember(db, SLUG, MINA)).toMatchObject({ slug: SLUG })
    expect((await spacesOf(db, MINA)).map((one) => one.slug)).toContain(SLUG)
  })

  it('lands once when the same person follows it twice', async () => {
    const secret = await invited()
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    const again = await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(again.kind).toBe('already-in')
    expect(await membersOf(db, SPACE, KAI)).toHaveLength(2)
    void secret
  })

  it('comes in as a member, not as somebody who can let others in', async () => {
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(await isOwner(db, SPACE, MINA)).toBe(false)
  })

  it('says the same about revoked, expired and never — one thing to do about all three', async () => {
    // Three sentences would be three ways of saying "ask them for another one". It also means a
    // link cannot be used to find out whether a Space exists.
    const revoked = await inviteInto(db, { spaceId: SPACE, by: KAI })
    await revokeInvitation(db, { id: revoked.id, spaceId: SPACE })

    const stale = await inviteInto(db, { spaceId: SPACE, by: KAI })
    await db
      .updateTable('invitations')
      .set({ expires_at: sql<Date>`now() - interval '1 day'` })
      .where('id', '=', stale.id)
      .execute()

    expect(await whatItOpens(db, revoked.secret)).toEqual({ kind: 'no-invitation' })
    expect(await whatItOpens(db, stale.secret)).toEqual({ kind: 'no-invitation' })
    expect(await whatItOpens(db, 'hi_never-existed')).toEqual({ kind: 'no-invitation' })
  })

  it('is not revoked by an id from another Space', async () => {
    const made = await inviteInto(db, { spaceId: SPACE, by: KAI })
    const elsewhere = await createSpace(db, {
      requestKey: `other-${RUN}`,
      userId: MINA,
      displayName: `Beta ${RUN.slice(0, 8)}`,
      slug: normalizeSlug(`Beta ${RUN.slice(0, 8)}`) as Slug,
    })
    if (elsewhere.kind !== 'created') throw new Error('the fixture could not make a second Space')

    expect(await revokeInvitation(db, { id: made.id, spaceId: elsewhere.space.id })).toBe(false)
    expect(await whatItOpens(db, made.secret)).toMatchObject({ kind: 'open' })
  })

  it('is not listed once it has been revoked', async () => {
    const made = await inviteInto(db, { spaceId: SPACE, by: KAI })
    expect(await invitationsInto(db, SPACE)).toHaveLength(1)

    await revokeInvitation(db, { id: made.id, spaceId: SPACE })

    expect(await invitationsInto(db, SPACE)).toEqual([])
  })
})

describe('roles', () => {
  it('makes another owner, so the first one is not the only way in', async () => {
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(await becomes(db, { spaceId: SPACE, userId: MINA }, ROLE.owner)).toEqual({
      kind: 'moved',
    })
    expect(await isOwner(db, SPACE, MINA)).toBe(true)
  })

  it('says so rather than moving somebody who is not here', async () => {
    expect(await becomes(db, { spaceId: SPACE, userId: MINA }, ROLE.owner)).toEqual({
      kind: 'not-a-member',
    })
  })
})

describe('the last owner', () => {
  it('cannot step down, because nobody would be able to let anybody in', async () => {
    // GitHub refuses this in as many words. A Space whose only owner became a member is a Space
    // where nothing can be invited, removed or renamed, by anybody, ever.
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(await becomes(db, { spaceId: SPACE, userId: KAI }, ROLE.member)).toEqual({
      kind: 'the-last-owner',
    })
    expect(await isOwner(db, SPACE, KAI)).toBe(true)
  })

  it('cannot leave either, and the Space is unchanged when they try', async () => {
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(await removes(db, { spaceId: SPACE, userId: KAI })).toEqual({ kind: 'the-last-owner' })
    expect(await membersOf(db, SPACE, KAI)).toHaveLength(2)
  })

  it('can leave once somebody else is an owner too', async () => {
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })
    await becomes(db, { spaceId: SPACE, userId: MINA }, ROLE.owner)

    expect(await removes(db, { spaceId: SPACE, userId: KAI })).toEqual({ kind: 'moved' })
    expect(await isOwner(db, SPACE, MINA)).toBe(true)
  })
})

describe('a link revoked while somebody is following it', () => {
  it('does not let them in, however close the two moments are', async () => {
    // Read and written separately, this is a link somebody watched go dark on their own screen
    // and that worked anyway. The row is locked by the transaction that joins, so a revoke either
    // commits before the read — and this refuses — or waits behind it and stops the next person.
    const secret = await invited()
    const holder = new Client({ connectionString: loadEnv().DATABASE_URL })
    await holder.connect()
    await holder.query('begin')
    // Whoever is revoking has the invitation row. The join must wait rather than read past it.
    await holder.query('update invitations set revoked_at = now() where space_id = $1', [SPACE])

    let done = false
    const following = joinWith(db, { secret, userId: MINA }).then((joined) => {
      done = true
      return joined
    })

    try {
      await new Promise((wake) => setTimeout(wake, 200))
      expect(done).toBe(false)
    } finally {
      await holder.query('commit')
      await holder.end()
    }

    expect(await following).toEqual({ kind: 'no-invitation' })
    expect(await spaceForMember(db, SLUG, MINA)).toBeUndefined()
  }, 20_000)
})

describe('two owners changing hands at the same moment', () => {
  it('takes the Space\u2019s turn first, so the deferred rule is asked about reality', async () => {
    // The rule that a Space keeps an owner is a deferred trigger, and a deferred trigger runs at
    // commit \u2014 where it cannot see a transaction that has not committed. Two owners demoting
    // each other each look across, each sees the other still an owner, both pass, and the Space is
    // left with nobody who can let anybody in. No unique index can say "at least one", so nothing
    // else catches it.
    //
    // Written by holding the Space's turn from another connection rather than by racing two
    // calls: a race either interleaves or it does not, and a test that passes because the timing
    // did not line up proves nothing at all.
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })
    await becomes(db, { spaceId: SPACE, userId: MINA }, ROLE.owner)

    const holder = new Client({ connectionString: loadEnv().DATABASE_URL })
    await holder.connect()
    await holder.query('begin')
    await holder.query('select pg_advisory_xact_lock(hashtext($1))', [`owners:${SPACE}`])

    let done = false
    const waiting = becomes(db, { spaceId: SPACE, userId: KAI }, ROLE.member).then((moved) => {
      done = true
      return moved
    })

    try {
      await new Promise((wake) => setTimeout(wake, 200))
      // Still waiting: it has not read who the owners are yet, let alone decided.
      expect(done).toBe(false)
    } finally {
      await holder.query('commit')
      await holder.end()
    }

    expect(await waiting).toEqual({ kind: 'moved' })
  }, 20_000)
})

describe('somebody who was removed', () => {
  it('stops being able to reach the Space at all', async () => {
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })
    await removes(db, { spaceId: SPACE, userId: MINA })

    // Every one of these is a different read of membership, and forgetting any one of them is a
    // person who was removed still being answered.
    expect(await spaceForMember(db, SLUG, MINA)).toBeUndefined()
    expect((await spacesOf(db, MINA)).map((one) => one.slug)).not.toContain(SLUG)
    expect(await membersOf(db, SPACE, KAI)).toHaveLength(1)
  })

  it('is put back exactly where they were when they are invited again', async () => {
    // The row is still there, which is why there is no window that expires: GitHub keeps three
    // months and Notion thirty days, and both of those are a day on which somebody's answer
    // silently changes.
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })
    await becomes(db, { spaceId: SPACE, userId: MINA }, ROLE.owner)
    await removes(db, { spaceId: SPACE, userId: MINA })

    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })

    expect(await isOwner(db, SPACE, MINA)).toBe(true)
  })
})

describe('before somebody is taken out', () => {
  it('says what is still theirs, so nothing is decided for anybody', async () => {
    // Not a button, a list. Linear does not reassign a removed member's open issues and Devin
    // lets a running session finish — and this codebase already says the same thing about a
    // failed turn: whether it matters is a person's to say.
    await joins(db, { userId: MINA, spaceId: SPACE, slug: SLUG })
    const held = await whatTheyHold(db, { spaceId: SPACE, userId: MINA })

    // Nothing yet, which is the answer for somebody who just arrived — and the shape a page has
    // to read either way.
    expect(held).toEqual({ working: [], machines: [] })
  })
})
