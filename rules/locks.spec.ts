/**
 * That rows locked one at a time are locked in an order everybody agrees on.
 *
 * Two transactions that take the same two rows in opposite orders deadlock, and Postgres resolves
 * it by killing one of them — which reaches a person as an unexplained failure in the middle of
 * something that should have worked. The order only has to be *some* order; it has to be the same
 * one every time.
 *
 * A loop is where this goes wrong quietly. `select … from turns where machine_id = $1` has no
 * `order by`, so Postgres may hand back the rows in whatever order the plan produced — and it is
 * free to produce a different one on the next execution, after a write or a vacuum. Locking each
 * conversation as the loop reaches it then takes them in an order nobody chose. One caller is
 * fine; two are a coin flip, and a machine reporting a restart twice because the first response
 * timed out is exactly two.
 *
 * Nothing else catches it. It type-checks, every test passes, and it is invisible until two
 * requests land close enough together — at which point it is a fault a person cannot reproduce.
 *
 * Made red once against `openTurnsOn`, which is the loop that prompted the rule.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER = 'apps/server/src'

/** `for (const one of these)` — the name being iterated is what has to have been ordered. */
const ITERATES = /for\s*(?:await\s*)?\(\s*const\s+[\w{},\s]+\s+of\s+([\w.]+)\s*\)/gu

function under(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    const path = join(from, entry)

    if (statSync(path).isDirectory()) return under(path)

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** The body of a `for` block, from its opening brace to the brace that closes it. */
function bodyAfter(source: string, from: number): string {
  const open = source.indexOf('{', from)
  if (open === -1) return ''

  let depth = 0
  for (let at = open; at < source.length; at += 1) {
    depth += source[at] === '{' ? 1 : 0
    depth -= source[at] === '}' ? 1 : 0
    if (depth === 0) return source.slice(open, at)
  }

  return source.slice(open)
}

/**
 * Where a name got its rows, as source: the expression it was assigned, and — when that is a call
 * to something declared in the same file — that function's body too.
 */
function whereFrom(source: string, name: string): string {
  const assigned = new RegExp(String.raw`const\s+${name}\s*=\s*([^\n]*(?:\n\s+\.[^\n]*)*)`, 'u')
  const found = assigned.exec(source)?.[1] ?? ''
  const calls = /await\s+(\w+)\s*\(/u.exec(found)?.[1]
  if (calls === undefined) return found

  const declared = new RegExp(String.raw`function\s+${calls}\s*\(`, 'u').exec(source)
  if (declared === null) return found

  // To the brace that closes it at the left margin, rather than to the first `{` after its name:
  // a return type can carry one — `Promise<readonly { conversationId: string }[]>` — and stopping
  // there reads the shape of the answer instead of the query that produced it.
  const ends = source.indexOf('\n}', declared.index)

  return found + source.slice(declared.index, ends === -1 ? undefined : ends)
}

/** The loops in one file that lock as they go, over rows nobody put in an order. */
function unorderedIn(path: string): readonly string[] {
  const source = readFileSync(path, 'utf8')

  return [...source.matchAll(ITERATES)]
    .filter((one) => bodyAfter(source, one.index).includes('.forUpdate('))
    .filter((one) => !whereFrom(source, one[1] as string).includes('.orderBy('))
    .map((one) => `${path}: for … of ${one[1] as string}`)
}

describe('a loop that locks a row each time round', () => {
  it('is handed its rows in an order that does not change between two callers', () => {
    expect(under(SERVER).flatMap(unorderedIn)).toEqual([])
  })
})
