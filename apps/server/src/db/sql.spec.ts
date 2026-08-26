/**
 * Where SQL is allowed to be written by hand, and why each one is.
 *
 * Two rules, both mechanical, because both are the kind that drift one file at a time and are
 * never noticed until somebody reads the whole tree at once.
 *
 * See `docs/code-style.md` 9 for the rule these enforce.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = 'apps/server/src'

/** A `sql` template whose contents begin a statement, rather than an expression inside a query. */
const A_STATEMENT = /^(with|select|insert|update|delete)\b/i

function everySource(from = SOURCE): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)
    if (statSync(path).isDirectory()) return everySource(path)

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** Every hand-written `sql` template, as the file it is in and the first words of it. */
function everyStatement(): readonly string[] {
  return everySource()
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8')

      return [...source.matchAll(/sql(?:<[^>]*>)?`([\s\S]*?)`/g)].flatMap((found) => {
        const body = (found[1] ?? '').trim()

        return A_STATEMENT.test(body)
          ? [`${path.replace(`${SOURCE}/`, '')}  ${body.split(/\s+/).slice(0, 4).join(' ')}`]
          : []
      })
    })
    .sort()
}

describe('where SQL may be written by hand', () => {
  it('is the persistence boundary and nowhere else', async () => {
    // A query in a route handler is a route that owns a fact. `repository.md` says `db/` is the
    // persistence boundary; this is what makes that true rather than intended.
    const elsewhere = everySource()
      .filter((path) => !path.startsWith(`${SOURCE}/db/`))
      .filter((path) => /sql(<[^>]*>)?`/.test(readFileSync(path, 'utf8')))

    expect(elsewhere).toEqual([])
  })

  it('is this list of statements, which somebody has to change on purpose', async () => {
    // The default is the query builder: its types come from the live schema, so a column that
    // moved breaks the build. Two things are allowed to drop below it, and each one here is one
    // of the two:
    //
    //   not a query          pg_notify, advisory locks. The builder has nothing to say them with,
    //                        and they are procedure calls rather than questions about rows.
    //
    //   the SQL *is* the     one statement that writes and reads in the same snapshot, or walks a
    //   correctness          tree. Written through the builder, a reader still has to rebuild the
    //                        SQL in their head to see whether the locking and the snapshot are
    //                        right — which is more to understand, not less.
    //
    // Adding a line here is easy and that is the point: it cannot happen by accident.
    expect(everyStatement()).toEqual([
      'db/credential.ts  select pg_advisory_xact_lock(hashtext(${',
      'db/email-code.ts  select pg_advisory_xact_lock(hashtext(${',
      'db/live.ts  select pg_notify(${CHANNEL}, ${JSON.stringify(shortened(happening))})',
      'db/space.ts  select pg_advisory_xact_lock(hashtext(${request.requestKey}))',
      'db/task.ts  with due as (',
      'db/task.ts  with recursive tree as',
      'db/turn.ts  with ${owedATurn(machineId)}, claimed as',
      'db/waking.ts  select pg_notify(${CHANNEL}, ${machineId})',
    ])
  })
})
