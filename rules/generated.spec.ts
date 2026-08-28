/**
 * That what is committed under `generated/` came from this branch's migrations and nothing else.
 *
 * It is rebuilt by introspecting a real database, which is the right way to get it and the reason
 * it can be wrong: whatever else is in that database comes along. This repository's own test
 * database is shared with other work, and three tables from a different branch were committed
 * here without a word — ninety-one lines of a schema this branch has no migration for.
 *
 * `pnpm check` regenerates and fails on a diff, so it catches drift between the code and the
 * database it was generated from. It cannot catch this: the file matched the database exactly.
 * What is asked here is the other direction — every table the artefacts name is one a migration
 * in this repository creates.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATIONS = 'apps/server/migrations'

const TYPES = 'apps/server/generated/db.ts'

/** The map at the foot of the generated types: every table, by the name Postgres knows it by. */
const IN_THE_TYPES = /^export interface DB \{([\s\S]*?)^\}/mu

/**
 * Every table this branch has a migration for: the ones it creates, and the names it renames to.
 *
 * A rename is as much this branch's table as a create — asked only about `create table`, this
 * read a renamed one as somebody else's schema, which is the opposite of what it is for. Nothing
 * is taken away on a drop or a rename-from: the artefacts are generated from a database that
 * holds every migration, so a name that is gone by the end cannot be in them anyway.
 */
function migrated(): ReadonlySet<string> {
  const sql = readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith('.sql'))
    .map((entry) => readFileSync(join(MIGRATIONS, entry), 'utf8'))
    .join('\n')

  const said = [
    ...sql.matchAll(/create table (?:if not exists )?(\w+)/giu),
    ...sql.matchAll(/alter table (?:only )?\w+ rename to (\w+)/giu),
  ]

  return new Set(said.map((one) => (one[1] ?? '').toLowerCase()))
}

/** Every table the committed types carry. */
function typed(): readonly string[] {
  const block = IN_THE_TYPES.exec(readFileSync(TYPES, 'utf8'))?.[1] ?? ''

  return [...block.matchAll(/^\s+(\w+):/gmu)].map((one) => one[1] ?? '')
}

describe('what is committed under generated/', () => {
  it('names no table this branch has no migration for', () => {
    const ours = migrated()

    expect(typed().filter((table) => !ours.has(table))).toEqual([])
  })
})
