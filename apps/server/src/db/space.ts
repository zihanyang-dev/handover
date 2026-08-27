/**
 * Persisting the Space that `space` owns, together with the membership that makes it reachable.
 *
 * Locks, in the order every path here takes them:
 *   1. an advisory lock keyed on the request key
 *   2. the `spaces` row for the requested slug, via the unique index
 *   3. the `memberships` row that names the requester
 *
 * Step 1 serialises a request against its own retries, which is what lets step 2 be read plainly:
 * if the slug is held once we get there, it is held by somebody else, and the answer is a
 * suggestion. Two different requests wanting the same name still race, and the unique index
 * decides that one — a late writer finds out in SQL.
 */

import { sql } from 'kysely'
import { nextFreeSlug, type Slug } from '@handover/universal'
import type { Database } from './connection.ts'
import { ROLE } from './membership.ts'

export type SpaceRequest = {
  /** The caller's idempotency key. Retrying with the same one must not create a second Space. */
  readonly requestKey: string
  readonly userId: string
  readonly displayName: string
  /** Already normalised. Whether a name is usable at all is decided before this is called. */
  readonly slug: Slug
}

export type Space = {
  readonly id: string
  readonly slug: string
  readonly displayName: string
}

export type SpaceCreation =
  | { readonly kind: 'created'; readonly space: Space }
  /** This request key already created a Space. The same one, not a second. */
  | { readonly kind: 'replayed'; readonly space: Space }
  /** Someone else holds the slug. The suggestion is not held for anyone. */
  | { readonly kind: 'slug-taken'; readonly suggestion: Slug }

/**
 * The Space this person's own retry already made.
 *
 * Keyed on who as well as on what: a request key is the caller's own string, and read globally,
 * anybody who guessed or reused one would be handed the id, slug and name of a private Space they
 * are not a member of.
 */
async function spaceFor(
  db: Database,
  // Named rather than ordered: a request key is the caller's own opaque string and a user id is
  // ours, and swapped they match no row at all — which reads as "you never made that one".
  whose: { readonly requestKey: string; readonly userId: string },
): Promise<Space | undefined> {
  const row = await db
    .selectFrom('memberships')
    .innerJoin('spaces', 'spaces.id', 'memberships.space_id')
    .select(['spaces.id as id', 'spaces.slug as slug', 'spaces.display_name as displayName'])
    .where('memberships.request_key', '=', whose.requestKey)
    .where('memberships.user_id', '=', whose.userId)
    // A retry from somebody who has since been removed makes nothing and finds nothing: the
    // answer to "did I already make this" is about a Space they can still reach.
    .where('memberships.revoked_at', 'is', null)
    .executeTakeFirst()
  return row
}

async function suggestionFor(db: Database, slug: Slug): Promise<Slug> {
  // The charset a slug is normalised into contains no `%` or `_`, so this pattern needs no escape.
  const rows = await db
    .selectFrom('spaces')
    .select('slug')
    .where((eb) => eb.or([eb('slug', '=', slug), eb('slug', 'like', `${slug}-%`)]))
    .execute()
  return nextFreeSlug(
    slug,
    rows.map((row) => row.slug),
  )
}

/** Creates a Space with the requester as its first member, or says why it did not. */
export async function createSpace(db: Database, request: SpaceRequest): Promise<SpaceCreation> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${request.requestKey}))`.execute(tx)

    const already = await spaceFor(tx, { requestKey: request.requestKey, userId: request.userId })
    if (already !== undefined) return { kind: 'replayed', space: already }

    const created = await tx
      .insertInto('spaces')
      .values({ display_name: request.displayName, slug: request.slug })
      .onConflict((clash) => clash.column('slug').doNothing())
      .returning(['id', 'slug', 'display_name as displayName'])
      .executeTakeFirst()

    if (created === undefined) {
      return { kind: 'slug-taken', suggestion: await suggestionFor(tx, request.slug) }
    }

    await tx
      .insertInto('memberships')
      // Its owner, not merely its first member. Somebody has to be able to let the second person
      // in, and a Space that begins with nobody who can is a Space nobody can ever join.
      .values({
        space_id: created.id,
        user_id: request.userId,
        request_key: request.requestKey,
        role: ROLE.owner,
      })
      .execute()

    return { kind: 'created', space: created }
  })
}

/** The Spaces this person belongs to, oldest first. No "recently visited": there is no such fact. */
export async function spacesOf(db: Database, userId: string): Promise<readonly Space[]> {
  return db
    .selectFrom('memberships')
    .innerJoin('spaces', 'spaces.id', 'memberships.space_id')
    .select(['spaces.id as id', 'spaces.slug as slug', 'spaces.display_name as displayName'])
    .where('memberships.user_id', '=', userId)
    .where('memberships.revoked_at', 'is', null)
    .orderBy('spaces.created_at')
    .execute()
}

/**
 * The Space at this path, if it is one this person can reach.
 *
 * Membership is part of the same query rather than a check after it. A Space that does not exist
 * and a Space somebody is not in are both simply absent here, so no caller can accidentally tell
 * the two apart and turn the address bar into a way to find out what exists.
 */
export async function spaceForMember(
  db: Database,
  slug: string,
  userId: string,
): Promise<Space | undefined> {
  return (
    db
      .selectFrom('spaces')
      .innerJoin('memberships', 'memberships.space_id', 'spaces.id')
      .select(['spaces.id as id', 'spaces.slug as slug', 'spaces.display_name as displayName'])
      .where('spaces.slug', '=', slug)
      .where('memberships.user_id', '=', userId)
      // The door. Somebody removed gets the same answer as somebody who was never here and the
      // same answer as a Space that does not exist — one answer, so an address tells nobody
      // anything they did not already know.
      .where('memberships.revoked_at', 'is', null)
      .executeTakeFirst()
  )
}
