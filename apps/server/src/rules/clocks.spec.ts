/**
 * That a column saying when something happened is stamped by the wall clock.
 *
 * Postgres has two clocks and both spellings are ordinary SQL, so neither looks wrong on its own.
 * `now()` is the instant the transaction began and does not move while it runs; a transaction
 * that reads, thinks and then writes stamps a row with a time before things that really happened
 * earlier. `clock_timestamp()` is the wall clock.
 *
 * This was already broken in four places when the rule was written down — `revoked_at` was
 * stamped with both, in two files, and so was `ended_at`. Nothing could have found that by
 * reading one file. See `db/connection.ts` for the whole rule.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TABLES = 'apps/server/src/db'

/**
 * A column being stamped with a bare clock: `something_at: sql`now()``.
 *
 * Bare on purpose, and this is the whole of the rule's precision. Two other shapes use `now()`
 * and both are right: `expires_at > now()` compares against a deadline, and
 * `expires_at: now() + interval …` computes one — a deadline wants the transaction's instant so
 * that everything written in one transaction runs out together. Neither is a moment.
 */
const STAMPED = /(\w+_at):\s*sql(?:<[^>]*>)?`\s*(\w+\(\))\s*`/gu

/** The ones stamped with the transaction's clock where the wall clock was meant. */
function stampedWrong(source: string): readonly string[] {
  return [...source.matchAll(STAMPED)]
    .filter(([, , clock]) => clock === 'now()')
    .map(([, column]) => column ?? '')
}

/** What this file stamps with the wrong clock, named so the failure says where to look. */
function wrongIn(entry: string): readonly string[] {
  const found = stampedWrong(readFileSync(join(TABLES, entry), 'utf8'))

  return found.map((column) => `${entry}: ${column}`)
}

describe('a column that says when something happened', () => {
  it('is stamped by the wall clock, not by the instant its transaction began', () => {
    const files = readdirSync(TABLES).filter(
      (entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'),
    )

    expect(files.flatMap(wrongIn)).toEqual([])
  })
})
