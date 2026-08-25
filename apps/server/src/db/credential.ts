/**
 * The rows that say what opens an account, and the two ways one gets added.
 *
 * One table, one row each. Everything that decides who somebody is goes through here, so the rule
 * "one credential opens one account" is stated once, in an index, and cannot be forgotten by a
 * caller that queries the table its own way.
 *
 * Nothing here looks at addresses to decide whether a credential belongs to whoever is adding it.
 * The session already proved whose account this is; demanding that a provider's address match the
 * account's was inherited from the days when the account *was* an address, and it protected
 * nothing once that stopped being true.
 *
 * Locks, in the order every path here takes them:
 *   1. the advisory lock on the address, for the paths that touch one
 *   2. the `credentials` row, via its unique index
 */

import { sql } from 'kysely'
import { canonical, type Credential } from '../identity/credential.ts'
import type { Rejection } from '../identity/email-code.ts'
import type { ProviderIdentity } from '../identity/provider.ts'
import type { Database, Tx } from './connection.ts'
import { spendCode } from './email-code.ts'

/**
 * Serializes everyone arriving at one address, whatever kind of credential they carry.
 *
 * Two people proving the same address at the same moment through different providers both find
 * nothing, both make an account, and the address ends up deciding nothing. A unique index cannot
 * catch it on its own here: the `users` row has to exist before the credential that would collide can
 * be written, so losing the race would leave an account behind that nothing opens.
 */
export async function holdTheAddress(tx: Tx, address: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`credential:${address}`}))`.execute(tx)
}

/** Whose account this credential opens, or nobody's. */
export async function holderOf(db: Database, credential: Credential): Promise<string | undefined> {
  const wanted = canonical(credential)
  const row = await db
    .selectFrom('credentials')
    .select('user_id')
    .where('kind', '=', wanted.kind)
    .where('subject', '=', wanted.subject)
    .executeTakeFirst()
  return row?.user_id
}

/** Every credential this account holds, oldest first, so the first address is the one it started with. */
export async function credentialsOf(db: Database, userId: string): Promise<readonly Credential[]> {
  const rows = await db
    .selectFrom('credentials')
    .select(['kind', 'subject'])
    .where('user_id', '=', userId)
    .orderBy('verified_at')
    .orderBy('subject')
    .execute()
  return rows.map((row) => ({ kind: row.kind, subject: row.subject }) as Credential)
}

/**
 * Puts a credential on an account, and says whether it went on.
 *
 * `do nothing` absorbs one already sitting exactly where it is being put, which is a retry and not
 * a problem. It also absorbs the account already holding a different account at the same provider
 * — that one *is* a problem, so callers check for it before getting here rather than letting it
 * look like success.
 */
export async function link(db: Database, userId: string, credential: Credential): Promise<boolean> {
  const wanted = canonical(credential)
  const written = await db
    .insertInto('credentials')
    .values({ user_id: userId, kind: wanted.kind, subject: wanted.subject })
    .onConflict((clash) => clash.doNothing())
    .returning('user_id')
    .executeTakeFirst()
  return written !== undefined
}

export type Connection =
  | { readonly kind: 'connected' }
  | {
      readonly kind: 'rejected'
      readonly rejection:
        /** Somebody else already reaches their account this way. */
        | 'linked-elsewhere'
        /** This account already reaches a different account at this provider. */
        | 'already-connected'
    }

export async function connectProvider(
  db: Database,
  userId: string,
  identity: ProviderIdentity,
): Promise<Connection> {
  const credential: Credential = { kind: identity.provider, subject: identity.subject }

  return db.transaction().execute(async (tx) => {
    const owner = await holderOf(tx, credential)
    if (owner === userId) return { kind: 'connected' }
    if (owner !== undefined) return { kind: 'rejected', rejection: 'linked-elsewhere' }

    // One provider account per account, so a second one is a different situation with a different
    // answer. Absorbing it would report a connection that never happened.
    const held = await credentialsOf(tx, userId)
    if (held.some((existing) => existing.kind === identity.provider)) {
      return { kind: 'rejected', rejection: 'already-connected' }
    }

    // The index decides the race, not the read above: two transactions can both find nothing.
    // The loser writes nothing, and telling it "connected" would show a way in that is not there.
    if (await link(tx, userId, credential)) return { kind: 'connected' }

    const won = await holderOf(tx, credential)
    if (won === userId) return { kind: 'connected' }

    return {
      kind: 'rejected',
      rejection: won === undefined ? 'already-connected' : 'linked-elsewhere',
    }
  })
}

export type Attachment =
  /** On, or already on. Asking twice changed nothing, and nothing went wrong either time. */
  | { readonly kind: 'attached' }
  /**
   * The address opens somebody else's account.
   *
   * Said plainly, because whoever is being told has just proved they receive mail there — they
   * could sign in to that account with the next code. There is nothing left to keep from them.
   */
  | { readonly kind: 'rejected'; readonly rejection: 'address-elsewhere' }
  | { readonly kind: 'refused'; readonly rejection: Rejection }

/**
 * Proves an address with a code and hangs it on this account, in one transaction.
 *
 * Both halves commit together for the same reason signing in does: a code spent without its
 * consequence leaves somebody holding something the system now calls used.
 *
 * It never moves an address off the account that already holds it. Moving one would be the whole
 * of account takeover — a key quietly stops opening the door it used to.
 */
export async function addAddress(
  db: Database,
  secret: string,
  userId: string,
  answer: { readonly codeId: string; readonly code: string },
): Promise<Attachment> {
  return db.transaction().execute(async (tx) => {
    const spent = await spendCode(tx, secret, { purpose: 'attach', ...answer })
    if (spent.kind === 'rejected') return { kind: 'refused', rejection: spent.rejection }

    const credential: Credential = { kind: 'email', subject: spent.address }
    await holdTheAddress(tx, spent.address)

    const owner = await holderOf(tx, credential)
    if (owner !== undefined && owner !== userId) {
      return { kind: 'rejected', rejection: 'address-elsewhere' }
    }

    await link(tx, userId, credential)
    return { kind: 'attached' }
  })
}
