/**
 * The rows that say what opens an account.
 *
 * One table, one row per key. Everything that decides who somebody is goes through here, so the
 * rule "one key opens one account" is stated once, in an index, and cannot be forgotten by a
 * caller that queries the table its own way.
 */

import { sql } from 'kysely'
import { canonical, type Key } from '../identity/way-in.ts'
import type { Database, Tx } from './connection.ts'

/**
 * Serializes everyone arriving at one address, whatever kind of key they carry.
 *
 * Two people proving the same address at the same moment through different providers both find
 * nothing, both make an account, and the address ends up deciding nothing. A unique index cannot
 * catch it on its own here: the `users` row has to exist before the key that would collide can be
 * written, so losing the race would leave an account behind that nothing opens.
 */
async function holdTheAddress(tx: Tx, address: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`way-in:${address}`}))`.execute(tx)
}

/** Whose account this key opens, or nobody's. */
export async function holderOf(db: Database, key: Key): Promise<string | undefined> {
  const wanted = canonical(key)
  const row = await db
    .selectFrom('ways_in')
    .select('user_id')
    .where('kind', '=', wanted.kind)
    .where('subject', '=', wanted.subject)
    .executeTakeFirst()
  return row?.user_id
}

/** Every key this account holds, oldest first, so the first address is the one it started with. */
export async function keysOf(db: Database, userId: string): Promise<readonly Key[]> {
  const rows = await db
    .selectFrom('ways_in')
    .select(['kind', 'subject'])
    .where('user_id', '=', userId)
    .orderBy('verified_at')
    .orderBy('subject')
    .execute()
  return rows.map((row) => ({ kind: row.kind, subject: row.subject }) as Key)
}

/**
 * Hangs a key on an account, and says whether it went on.
 *
 * `do nothing` absorbs a key already hanging exactly where it is being hung, which is a retry and
 * not a problem. It also absorbs the account already holding a different account at the same
 * provider — that one is a problem, so callers check for it before getting here rather than
 * letting it look like success.
 */
export async function hang(db: Database, userId: string, key: Key): Promise<boolean> {
  const wanted = canonical(key)
  const written = await db
    .insertInto('ways_in')
    .values({ user_id: userId, kind: wanted.kind, subject: wanted.subject })
    .onConflict((clash) => clash.doNothing())
    .returning('user_id')
    .executeTakeFirst()
  return written !== undefined
}

export { holdTheAddress }
