/**
 * Signing in through a provider, and connecting one to an account that is already signed in.
 *
 * Locks, in the order every path here takes them:
 *   1. the `sign_in_methods` row for (provider, subject), via its unique index
 *   2. the `users` row for the address, via its unique index
 *
 * No advisory lock. There was one, and twenty simultaneous arrivals of the same person came out
 * the same without it: the unique index on the address already decides who wins, and the paths
 * that could lose absorb it. A lock nothing can be shown to need is a lock that stops being read.
 */

import type { ProviderIdentity } from '../identity/provider.ts'
import { openSession } from './browser-session.ts'
import type { Database } from './connection.ts'
import { personFor } from './user.ts'

export type ProviderSignIn = {
  readonly userId: string
  readonly sessionId: string
  /**
   * True when this sign-in attached the provider to an account that was already there.
   *
   * It is true exactly once per provider per account — the moment the link is made — so the
   * answer that carries it is the one time to mention it, and nothing has to remember having.
   */
  readonly merged: boolean
}

export type Connection =
  | { readonly kind: 'connected' }
  | {
      readonly kind: 'rejected'
      readonly rejection:
        /** That account over there is on a different address, so it is a different person here. */
        | 'email-mismatch'
        /** Somebody else already reaches their account this way. */
        | 'linked-elsewhere'
    }

async function linkedTo(db: Database, identity: ProviderIdentity): Promise<string | undefined> {
  const row = await db
    .selectFrom('sign_in_methods')
    .select('user_id')
    .where('kind', '=', identity.provider)
    .where('subject', '=', identity.subject)
    .executeTakeFirst()
  return row?.user_id
}

/**
 * `do nothing` absorbs the two ways a row can already be there: this provider account is recorded
 * already, or this person already reaches their account through a different account at the same
 * provider. Neither is a reason to turn away somebody who has just proved the address — and the
 * account they are let into is the one the address names either way.
 */
async function link(db: Database, userId: string, identity: ProviderIdentity): Promise<void> {
  await db
    .insertInto('sign_in_methods')
    .values({ user_id: userId, kind: identity.provider, subject: identity.subject })
    .onConflict((clash) => clash.doNothing())
    .execute()
}

/** Always signs somebody in: a verified address is the whole of what it takes to be somebody. */
export async function signInWithProvider(
  db: Database,
  identity: ProviderIdentity,
  sessionTokenHash: string,
): Promise<ProviderSignIn> {
  return db.transaction().execute(async (tx) => {
    const known = await linkedTo(tx, identity)
    if (known !== undefined) {
      // Been here before. The address over there may have changed since; the subject has not.
      return {
        userId: known,
        sessionId: await openSession(tx, known, sessionTokenHash),
        merged: false,
      }
    }

    const existing = await tx
      .selectFrom('users')
      .select('id')
      .where('verified_email', '=', identity.verifiedEmail)
      .executeTakeFirst()

    const userId = await personFor(tx, {
      name: identity.name,
      username: identity.username,
      verifiedEmail: identity.verifiedEmail,
    })
    await link(tx, userId, identity)

    return {
      userId,
      sessionId: await openSession(tx, userId, sessionTokenHash),
      merged: existing !== undefined,
    }
  })
}

/** Adds a way in to an account that is already somebody's, without ever moving the account. */
export async function connectProvider(
  db: Database,
  userId: string,
  identity: ProviderIdentity,
): Promise<Connection> {
  return db.transaction().execute(async (tx) => {
    const person = await tx
      .selectFrom('users')
      .select('verified_email')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()

    // The address is the account. Connecting one that proves a different address would make this
    // account reachable by somebody it is not.
    if (person.verified_email !== identity.verifiedEmail) {
      return { kind: 'rejected', rejection: 'email-mismatch' }
    }

    const owner = await linkedTo(tx, identity)
    if (owner !== undefined && owner !== userId) {
      return { kind: 'rejected', rejection: 'linked-elsewhere' }
    }

    await link(tx, userId, identity)
    return { kind: 'connected' }
  })
}
