/**
 * That nobody who was removed is still being answered.
 *
 * This is the failure this slice ships most easily, and it is silent: somebody taken out of a
 * Space who can still reach its machines, or who still gets its work in their Inbox. Nothing
 * breaks, no test goes red, and the only symptom is a person seeing something they should not.
 *
 * Membership is read from many places — the door on every Space route, whether a machine can be
 * reached, whose machines a Space lists, whose work is waiting. Each of them has to say
 * `revoked_at is null`, and one of them forgetting looks exactly like the others.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DB = 'apps/server/src/db'

/** Every query in one file, with the verb that began it, cut where one ends and the next does. */
function queries(source: string): readonly { readonly verb: string; readonly rest: string }[] {
  const cut = source.split(/\.(selectFrom|updateTable|deleteFrom|insertInto)\(/u)

  return cut
    .slice(1)
    .flatMap((piece, at) => (at % 2 === 0 ? [{ verb: piece, rest: cut[at + 2] ?? '' }] : []))
}

function everySource(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)
    if (statSync(path).isDirectory()) return everySource(path)

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** A query that reads memberships and never says which of them still count. */
function forgetful(): readonly string[] {
  return everySource(DB).flatMap((path) => {
    const source = readFileSync(path, 'utf8')

    return queries(source).flatMap((query, at) => {
      // An insert names no rows to leave out, so it is exempt by shape rather than by a list.
      if (query.verb === 'insertInto') return []
      const reads = /'memberships/u.test(query.rest)

      return reads && !query.rest.includes('revoked_at')
        ? [`${path.replace(`${DB}/`, '')} query ${String(at + 1)}`]
        : []
    })
  })
}

describe('reading who is in a Space', () => {
  it('never forgets to leave out the people who were removed', async () => {
    // Writing into `memberships` is exempt by shape: an insert names no rows to filter. Reading
    // one and not saying which of them count is the whole of this rule.
    expect(forgetful()).toEqual([])
  })
})
