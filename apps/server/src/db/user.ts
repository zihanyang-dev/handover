/**
 * Reading and renaming the person behind a session, and finding the person a key opens.
 *
 * Locks, in the order every path here takes them:
 *   1. the advisory lock on the address the key proves
 *   2. the `credentials` row, via its unique index
 */

import { initialDisplayName, type Profile } from '../identity/display-name.ts'
import { canonical, type Credential } from '../identity/credential.ts'
import type { Database, Tx } from './connection.ts'
import { credentialsOf, holdTheAddress, holderOf, link } from './credential.ts'

export type Person = {
  readonly id: string
  readonly displayName: string
  readonly credentials: readonly Credential[]
}

export async function personById(db: Database, id: string): Promise<Person | undefined> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'display_name as displayName'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) return undefined

  return { ...row, credentials: await credentialsOf(db, id) }
}

export type Arrival = {
  readonly userId: string
  /**
   * True when this key was hung on an account that was already there.
   *
   * It happens exactly once per key — the moment it goes on — so the answer that carries it is
   * the one time to mention it, and nothing has to remember having said it.
   */
  readonly merged: boolean
}

/**
 * The account a key opens, making one if it opens nothing yet.
 *
 * ```
 * 1. the key is already hanging somewhere      → that account
 * 2. the address it proves is hanging somewhere → that account, and the key goes on beside it
 * 3. neither                                    → a new account, holding both
 * ```
 *
 * Step 2 is the only place in the whole design where somebody reaches an account they never
 * proved they own. It stands on one thing: the provider handed back an address *it* had verified,
 * and verifying an address is exactly what the emailed code does. The same standard, not a weaker
 * one. Take away the unique index that makes an address reach one account and step 2 has no
 * answer, which is why that index is the load-bearing part and not this function.
 */
export async function arrive(tx: Tx, credential: Credential, profile: Profile): Promise<Arrival> {
  const address = canonical({ kind: 'email', subject: profile.address })
  await holdTheAddress(tx, address.subject)

  const direct = await holderOf(tx, credential)
  if (direct !== undefined) return { userId: direct, merged: false }

  // Skipped for an emailed code, where the key *is* the address and step 1 just answered this.
  if (credential.kind !== 'email') {
    const byAddress = await holderOf(tx, address)
    if (byAddress !== undefined) {
      await link(tx, byAddress, credential)
      return { userId: byAddress, merged: true }
    }
  }

  const created = await tx
    .insertInto('users')
    .values({ display_name: initialDisplayName(profile) })
    .returning('id')
    .executeTakeFirstOrThrow()

  await link(tx, created.id, address)
  if (credential.kind !== 'email') await link(tx, created.id, credential)

  return { userId: created.id, merged: false }
}

/** One name per person, not one per Space: changing it changes it everywhere they appear. */
export async function renamePerson(db: Database, id: string, displayName: string): Promise<void> {
  await db.updateTable('users').set({ display_name: displayName }).where('id', '=', id).execute()
}
