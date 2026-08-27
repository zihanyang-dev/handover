/**
 * A link somebody follows to join a Space.
 *
 * The same shape as an enrolment, because it answers the same question: how does something with
 * no standing here yet prove it is allowed in. Only the hash is kept, the plaintext exists once,
 * it expires, and it can be revoked — none of that is new, and a second mechanism for it would be
 * a second thing to get wrong.
 *
 * No address on it. A link works for whoever holds it, and the screen says so rather than a field
 * nothing checks pretending otherwise — Notion's secret link is the same bargain.
 */

import { sql } from 'kysely'
import type { Database } from './connection.ts'
import { hashSecret, mint } from '../secret.ts'

/** So one found in a shell history says which door it opens. */
const INVITATION = 'hi'

/** How long a link works for. Long enough to send and be read, short enough to go stale. */
const GOOD_FOR_DAYS = 7

export type Invitation = {
  readonly id: string
  readonly expiresAt: Date
  readonly madeBy: string
}

/** An invitation, and the one moment its plaintext exists. */
export type Made = Invitation & { readonly secret: string }

export async function inviteInto(
  db: Database,
  into: { readonly spaceId: string; readonly by: string },
): Promise<Made> {
  const secret = mint(INVITATION)
  const row = await db
    .insertInto('invitations')
    .values({
      space_id: into.spaceId,
      secret_hash: secret.hash,
      made_by: into.by,
      expires_at: sql<Date>`now() + ${GOOD_FOR_DAYS} * interval '1 day'`,
    })
    .returning(['id', 'expires_at as expiresAt', 'made_by as madeBy'])
    .executeTakeFirstOrThrow()

  return { ...row, secret: secret.secret }
}

/** The ones that still work here, newest first. Never their secrets — nobody has those any more. */
export async function invitationsInto(
  db: Database,
  spaceId: string,
): Promise<readonly Invitation[]> {
  return db
    .selectFrom('invitations')
    .select(['id', 'expires_at as expiresAt', 'made_by as madeBy'])
    .where('space_id', '=', spaceId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .orderBy('created_at', 'desc')
    .execute()
}

/** Stops one working. Says whether it was this call that stopped it, so a second one is honest. */
export async function revokeInvitation(
  db: Database,
  which: { readonly id: string; readonly spaceId: string },
): Promise<boolean> {
  const stopped = await db
    .updateTable('invitations')
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', which.id)
    // Named by the Space it is for, so an id from somewhere else revokes nothing rather than
    // revoking somebody else's invitation.
    .where('space_id', '=', which.spaceId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst()

  return stopped !== undefined
}

export type Held =
  | {
      readonly kind: 'open'
      readonly spaceId: string
      readonly slug: string
      readonly displayName: string
      readonly invitedBy: string
    }
  /** Revoked, run out, or never a link at all. One answer, because they are one thing to do. */
  | { readonly kind: 'no-invitation' }

/**
 * What this link is for.
 *
 * Expired, revoked and never-existed come back as one answer on purpose: what somebody does about
 * each of them is ask whoever sent it for another, and three different sentences would be three
 * ways of saying that. It also means a link cannot be used to find out whether a Space exists.
 */
export async function whatItOpens(db: Database, secret: string): Promise<Held> {
  const row = await db
    .selectFrom('invitations')
    .innerJoin('spaces', 'spaces.id', 'invitations.space_id')
    .innerJoin('users', 'users.id', 'invitations.made_by')
    .select([
      'spaces.id as spaceId',
      'spaces.slug as slug',
      'spaces.display_name as displayName',
      'users.display_name as invitedBy',
    ])
    .where('invitations.secret_hash', '=', hashSecret(secret))
    .where('invitations.revoked_at', 'is', null)
    .where('invitations.expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst()

  return row === undefined ? { kind: 'no-invitation' } : { kind: 'open', ...row }
}
