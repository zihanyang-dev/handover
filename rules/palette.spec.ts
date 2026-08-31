/**
 * That every colour name something reads is one something defines.
 *
 * A misspelt `var(--ink-quiett)` is the one CSS mistake nothing catches. It compiles, it ships,
 * and the property it was feeding falls back to its initial value — text goes black, a border
 * disappears, a fill turns transparent. There is no error anywhere, only a screen that looks
 * slightly wrong to whoever opens it next.
 *
 * Written before folding five palettes into one, because that fold renames roughly six hundred
 * call sites and a rename is exactly the operation that leaves a name behind. Made red once by
 * misspelling a real token, which is the only way to know a rule is looking.
 *
 * A `var()` with a fallback is not covered: it names something it does not require, which is a
 * different promise and a legitimate one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = 'apps/web'

/** `--name:` at the head of a declaration — the only place a custom property is given a value. */
const DEFINED = /(?:^|[;{\s])(--[a-z][a-z0-9-]*)\s*:/gu

/** `var(--name)` with nothing after the name: no fallback, so the definition must exist. */
const REQUIRED = /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gu

/**
 * A screen may hand one in two ways: through a style object, `style={{ '--sidebar-width': … }}`,
 * or as a Tailwind arbitrary property inside a class, `data-[progress=50]:[--at:50%]`.
 */
const HANDED_IN = /['"](--[a-z][a-z0-9-]*)['"]\s*:|\[(--[a-z][a-z0-9-]*):/gu

/**
 * Tailwind writes these itself, and `@theme` turns `--color-x` into utilities rather than into a
 * name anything reads back. Neither is ours to define.
 */
function isTailwinds(name: string): boolean {
  return name.startsWith('--tw-')
}

function under(from: string, ends: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    const path = join(from, entry)

    if (statSync(path).isDirectory()) return under(path, ends)

    return path.endsWith(ends) ? [path] : []
  })
}

function namesIn(pattern: RegExp, paths: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>()
  for (const path of paths) {
    for (const one of readFileSync(path, 'utf8').matchAll(pattern)) {
      found.add((one[1] ?? one[2]) as string)
    }
  }

  return found
}

/** The names one file requires and cannot get, in the form a reader can go and look up. */
function danglingIn(path: string, defined: ReadonlySet<string>): readonly string[] {
  return [...readFileSync(path, 'utf8').matchAll(REQUIRED)]
    .map((one) => one[1] as string)
    .filter((name) => !defined.has(name) && !isTailwinds(name))
    .map((name) => `${path}: var(${name})`)
}

describe('a colour name', () => {
  it('is read only where it is defined', () => {
    // Screens read them too — `bg-[var(--interaction-hover)]` is the same promise as a stylesheet
    // making it, and fails the same silent way.
    const stylesheets = under(WEB, '.css')
    const screens = under(WEB, '.tsx')
    const defined = new Set([...namesIn(DEFINED, stylesheets), ...namesIn(HANDED_IN, screens)])

    const dangling = [...stylesheets, ...screens].flatMap((path) => danglingIn(path, defined))

    expect([...new Set(dangling)]).toEqual([])
  })
})
