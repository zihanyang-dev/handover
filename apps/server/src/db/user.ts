/** Reading and renaming the person behind a session. */

import { initialDisplayName, type Profile } from '../identity/display-name.ts'
import type { Provider } from '../identity/provider.ts'
import type { Database } from './connection.ts'

export type Person = {
  readonly id: string
  readonly displayName: string
  readonly verifiedEmail: string
  readonly connected: readonly Provider[]
}

export async function personById(db: Database, id: string): Promise<Person | undefined> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'display_name as displayName', 'verified_email as verifiedEmail'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) return undefined

  const links = await db
    .selectFrom('sign_in_methods')
    .select('kind')
    .where('user_id', '=', id)
    .execute()

  return { ...row, connected: links.map((link) => link.kind as Provider) }
}

/**
 * The person who owns this address, creating them if this is the first time it has been proved.
 *
 * Whoever proves an address owns the account behind it. A second proof of the same address — by a
 * code this time, by Google the next — is that same person arriving another way, so it signs them
 * in rather than starting them over with a second account they did not ask for.
 */
export async function personFor(db: Database, profile: Profile): Promise<string> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('verified_email', '=', profile.verifiedEmail)
    .executeTakeFirst()
  if (existing !== undefined) return existing.id

  const created = await db
    .insertInto('users')
    .values({
      verified_email: profile.verifiedEmail,
      display_name: initialDisplayName(profile),
    })
    .onConflict((clash) => clash.column('verified_email').doNothing())
    .returning('id')
    .executeTakeFirst()
  if (created !== undefined) return created.id

  // Somebody else proved the same address first. Theirs is the account; this is the same person.
  const winner = await db
    .selectFrom('users')
    .select('id')
    .where('verified_email', '=', profile.verifiedEmail)
    .executeTakeFirstOrThrow()
  return winner.id
}

/** One name per person, not one per Space: changing it changes it everywhere they appear. */
export async function renamePerson(db: Database, id: string, displayName: string): Promise<void> {
  await db.updateTable('users').set({ display_name: displayName }).where('id', '=', id).execute()
}
