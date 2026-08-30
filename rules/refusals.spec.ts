/**
 * That every refusal a screen branches on is one the server can actually send.
 *
 * A refusal's `reason` is a plain string on the wire — deliberately, because it is open: a slice
 * adds one without anybody regenerating a client. The cost is that a screen comparing against a
 * name nobody sends compiles, type-checks, passes every test that does not provoke that exact
 * refusal, and quietly shows the wrong sentence forever.
 *
 * Both of the ones this found were live at the time. A person who was the last owner of a Space
 * was told "Only an owner can change roles" — the screen was looking for `last-owner` and the
 * server says `the-last-owner`. Somebody pressing a handover card that had gone stale was told to
 * try again, and trying again could never work — the screen was looking for `nothing-to-hand-over`
 * and the server says `cannot-hand-over`.
 *
 * Only the exact comparison, which is the only shape that can be wrong this way. What a screen
 * does with a reason it does not recognise is the screen's business, and this says nothing about
 * it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER = 'apps/server/src'

const WEB = 'apps/web'

/** What a refusal is declared as: `reason: 'the-last-owner'`. */
const DECLARED = /\breason:\s*'([^']+)'/gu

/**
 * What a screen compares one against.
 *
 * Every form in use reads the word `reason` on the way to the comparison — `reason === '…'`,
 * `error.reason === '…'`, `reasonOf(thrown) === '…'` — so that is what anchors it. A comparison
 * that reached a reason without ever naming it would be missed, and would also be one nobody
 * reading the screen could tell was about a refusal.
 */
const COMPARED = /\breason(?:Of)?\b[^\n=]*===\s*'([^']+)'/gu

function under(from: string, keep: (path: string) => boolean): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    const path = join(from, entry)

    if (statSync(path).isDirectory()) return under(path, keep)

    return keep(path) ? [path] : []
  })
}

function sources(root: string): readonly string[] {
  return under(
    root,
    (path) =>
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.spec.ts') &&
      !path.endsWith('.spec.tsx'),
  )
}

function found(paths: readonly string[], pattern: RegExp): readonly (readonly [string, string])[] {
  return paths.flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(pattern)].map(
      (one) => [path, one[1] ?? ''] as readonly [string, string],
    ),
  )
}

describe('a refusal a screen reads by name', () => {
  it('is one this server sends', () => {
    const sent = new Set(found(sources(SERVER), DECLARED).map(([, reason]) => reason))
    const read = found(sources(WEB), COMPARED)

    expect(
      read.filter(([, reason]) => !sent.has(reason)).map(([path, reason]) => `${path}: ${reason}`),
    ).toEqual([])
  })
})
