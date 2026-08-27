/**
 * That no screen writes down a shape the contract already publishes.
 *
 * A page that declares `type Member = { userId: string; … }` has made a second copy of something
 * the server decides. The copy compiles for exactly as long as the two agree, and the day a field
 * is added it goes on compiling — which is the whole failure: nothing says the screen is now
 * showing less than it was handed.
 *
 * Two of these were found by reading, both called `Member`, both different, and one of them a
 * subset of the other. `Pick<…>` off the contract says the same thing and cannot drift.
 *
 * A type *derived* from the contract is not a copy: `Extract<Message, { role: 'tool' }>` and
 * `Me['spaces'][number]` both move when the contract does. What is asked here is narrower and
 * exact — an object literal written under a published name, which is the only shape that can go
 * on compiling while the two say different things.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCREENS = 'apps/web/features'

const CONTRACT = 'apps/server/generated/openapi.json'

/** `type Name = …`, and what it is equal to. */
const DECLARED = /^(?:export )?type (\w+)\s*=\s*(.*)$/gmu

function everyScreen(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)
    if (statSync(path).isDirectory()) return everyScreen(path)

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

/** What this file writes down under a name the contract already uses. */
function copiedIn(path: string, published: ReadonlySet<string>): readonly string[] {
  const source = readFileSync(path, 'utf8')

  return [...source.matchAll(DECLARED)]
    .filter(([, name, equals]) => published.has(name ?? '') && (equals ?? '').startsWith('{'))
    .map(([, name]) => `${path}: type ${name ?? ''}`)
}

describe('a shape the contract publishes', () => {
  it('is taken from it rather than written down again on a screen', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      components: { schemas: Record<string, unknown> }
    }
    const published = new Set(Object.keys(contract.components.schemas))

    expect(everyScreen(SCREENS).flatMap((path) => copiedIn(path, published))).toEqual([])
  })
})
