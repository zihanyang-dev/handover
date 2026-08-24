/**
 * Adding a way in to an account somebody is already signed in to.
 *
 * Nothing here looks at addresses to decide whether the key belongs. The session already proved
 * whose account this is; demanding that a provider's address match the account's was inherited
 * from the days when the account *was* an address, and it protected nothing once that stopped
 * being true. What is left is the only real question: does this key already open somebody else's.
 *
 * Locks, in the order every path here takes them:
 *   1. the advisory lock on the address being attached, for the address path only
 *   2. the `ways_in` row for the key, via its unique index
 */

import type { Rejection } from '../identity/emailed-code.ts'
import type { Provider, ProviderIdentity } from '../identity/provider.ts'
import type { Key } from '../identity/way-in.ts'
import type { Database } from './connection.ts'
import { spendCode } from './spend-code.ts'
import { hang, holdTheAddress, holderOf, keysOf } from './way-in.ts'

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
  const key: Key = { kind: identity.provider, subject: identity.subject }

  return db.transaction().execute(async (tx) => {
    const owner = await holderOf(tx, key)
    if (owner === userId) return { kind: 'connected' }
    if (owner !== undefined) return { kind: 'rejected', rejection: 'linked-elsewhere' }

    // One provider account per account, so a second one is a different situation with a different
    // answer. Absorbing it would report a connection that never happened.
    const held = await keysOf(tx, userId)
    if (held.some((existing) => existing.kind === identity.provider)) {
      return { kind: 'rejected', rejection: 'already-connected' }
    }

    await hang(tx, userId, key)
    return { kind: 'connected' }
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
  answer: { readonly challengeId: string; readonly code: string },
): Promise<Attachment> {
  return db.transaction().execute(async (tx) => {
    const spent = await spendCode(tx, secret, { purpose: 'attach', ...answer })
    if (spent.kind === 'rejected') return { kind: 'refused', rejection: spent.rejection }

    const key: Key = { kind: 'email', subject: spent.address }
    await holdTheAddress(tx, spent.address)

    const owner = await holderOf(tx, key)
    if (owner !== undefined && owner !== userId) {
      return { kind: 'rejected', rejection: 'address-elsewhere' }
    }

    await hang(tx, userId, key)
    return { kind: 'attached' }
  })
}

/** Which providers this account already reaches, for a screen that offers the rest. */
export async function connectedProviders(
  db: Database,
  userId: string,
): Promise<readonly Provider[]> {
  const held = await keysOf(db, userId)
  return held.filter((key) => key.kind !== 'email').map((key) => key.kind as Provider)
}
