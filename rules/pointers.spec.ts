/**
 * That a file a comment points at is a file that is here.
 *
 * Backticks around a filename mean "the thing in this repository", and every one of them is a
 * pointer somebody will follow. They rot silently: a file is renamed or a screen is deleted, and
 * the sentence about it stays, now sending its next reader to nothing. Three had already gone
 * that way — one of them naming the spec that was supposed to be the proof of a whole journey.
 *
 * A comment may still talk about something that is not here — where a thing came from, what it
 * used to be. It says so in words, without backticks, because backticks are the pointer.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = ['apps/server/src', 'apps/web', 'apps/cli/src', 'packages', 'e2e', 'rules']

/** Anything that is not ours to keep true: what a build wrote, and what somebody else's tool did. */
const NOT_OURS = new Set(['node_modules', 'dist', 'generated', 'coverage', '.looks'])

function under(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (NOT_OURS.has(entry)) return []
    const path = join(from, entry)
    if (statSync(path).isDirectory()) return under(path)

    return /\.tsx?$/u.test(entry) && entry !== 'routeTree.gen.ts' ? [path] : []
  })
}

/** Every file in the repository, by the name it would be pointed at with. */
function everyName(from: string): ReadonlySet<string> {
  const found = new Set<string>()
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      if (NOT_OURS.has(entry) || entry.startsWith('.')) continue
      const path = join(at, entry)
      if (statSync(path).isDirectory()) walk(path)
      else found.add(entry)
    }
  }
  walk(from)

  return found
}

/** What one file points at: a name in backticks that looks like a file rather than a suffix. */
function pointsAt(source: string): readonly string[] {
  return [...source.matchAll(/`([\w.][\w./-]*\.(?:ts|tsx|css|sql|md|json|sh))`/gu)].map(
    (found) => found[1] ?? '',
  )
}

/** What one file points at that is not here. Its own function: nesting is what the linter counts. */
function brokenIn(path: string, here: ReadonlySet<string>): readonly string[] {
  const missing = pointsAt(readFileSync(path, 'utf8')).filter(
    (named) => !here.has(named.split('/').at(-1) ?? named),
  )

  return missing.map((named) => `${path}: ${named}`)
}

describe('what a comment points at', () => {
  it('is a file that is here', () => {
    const here = everyName('.')

    expect(SOURCE.flatMap(under).flatMap((path) => brokenIn(path, here))).toEqual([])
  })
})
