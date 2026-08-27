/**
 * That every file lists what it needs in the same order, and each module once.
 *
 * Not a matter of taste: an edit that adds an import leaves it wherever the edit happened, and a
 * file whose first twenty lines are in no order is a file whose next reader cannot tell at a
 * glance what it depends on. It drifted here in one afternoon of moving things between files,
 * which is exactly when nobody is reading the top of the file.
 *
 * The order is the distance: the platform, then packages, then what is above this file, then what
 * is beside it. Alphabetical inside each, so there is one answer rather than a judgement.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = ['apps/server/src', 'apps/cli/src', 'apps/web/features', 'packages', 'e2e']

/** Where a module lives, as a number, so the order is a sort and not an argument. */
function distance(specifier: string): number {
  if (specifier.startsWith('node:')) return 0
  if (specifier.startsWith('./')) return 3
  if (specifier.startsWith('.')) return 2

  return 1
}

/** What a file says it needs, in the order it says it. */
function asked(source: string): readonly string[] {
  const found = source.matchAll(/^import(?: type)? [\s\S]*?from '([^']+)'$/gmu)

  return [...found].map((one) => one[1] ?? '')
}

function everySource(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)
    if (statSync(path).isDirectory()) return everySource(path)

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

/** Whether this file lists what it needs in the order everything else does. */
function inOrder(path: string): boolean {
  const said = asked(readFileSync(path, 'utf8'))
  const sorted = [...said].sort((a, b) => distance(a) - distance(b) || (a < b ? -1 : 1))

  return said.join() === sorted.join()
}

/** A module asked for twice, which is one import somebody did not see was already there. */
function askedTwice(path: string): readonly string[] {
  const said = asked(readFileSync(path, 'utf8'))
  const twice = said.filter((one, at) => said.indexOf(one) !== at)

  return [...new Set(twice)].map((one) => `${path}: ${one}`)
}

describe('what a file says it needs', () => {
  it('is listed in one order, so the top of a file reads the same everywhere', () => {
    expect(SOURCE.flatMap(everySource).filter((path) => !inOrder(path))).toEqual([])
  })

  it('names each module once, however many things it takes from it', () => {
    expect(SOURCE.flatMap(everySource).flatMap(askedTwice)).toEqual([])
  })
})
