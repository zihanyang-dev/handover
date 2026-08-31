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

/** Where `@theme` begins, after which a name becomes a utility rather than a name to read back. */
const THEME_BEGINS = '@theme'

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

/** One definition: the name, whether `@theme` owns it, and the names its own value reads. */
type Definition = {
  readonly name: string
  readonly themed: boolean
  readonly reads: readonly string[]
}

/** Every definition in one stylesheet, and every name read from somewhere that is not one. */
function readingIn(path: string): { definitions: Definition[]; uses: string[] } {
  const definitions: Definition[] = []
  const uses: string[] = []
  let themed = false

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.includes(THEME_BEGINS)) themed = true
    const reads = [...line.matchAll(REQUIRED)].map((one) => one[1] as string)
    const defines = /^\s*(--[a-z][a-z0-9-]*)\s*:(.*)$/u.exec(line)

    // A name read inside another name's value keeps that one alive only if it is alive itself.
    // Read from an ordinary declaration, it is alive because a screen renders it.
    if (defines === null) uses.push(...reads)
    else definitions.push({ name: defines[1] as string, themed, reads })
  }

  return { definitions, uses }
}

/**
 * Which class names Tailwind builds out of each `@theme` namespace.
 *
 * `--color-ink-faint` is spent as `text-ink-faint` or `bg-ink-faint`, never as the name itself, so
 * a name is only alive here if one of its own utilities is written somewhere. Matching the tail
 * alone would find `var(--ink-faint)` and the definition line above it, and every name would prove
 * itself.
 */
const SPENT_AS: Readonly<Record<string, readonly string[]>> = {
  color: [
    'accent',
    'bg',
    'border',
    'caret',
    'decoration',
    'divide',
    'fill',
    'from',
    'outline',
    'placeholder',
    'ring',
    'shadow',
    'stroke',
    'text',
    'to',
    'via',
  ],
  ease: ['ease'],
  font: ['font'],
  radius: ['rounded'],
  shadow: ['shadow'],
  spacing: ['gap', 'h', 'm', 'p', 'size', 'space', 'w'],
  text: ['text'],
}

/** Whether one `@theme` name is written as a class anywhere a class can be written. */
function spentAsUtility(name: string, classes: string): boolean {
  const named = /^--([a-z]+)-(.+)$/u.exec(name)
  if (named === null) return false

  const prefixes = SPENT_AS[named[1] as string]
  const tail = named[2] as string
  // A namespace this does not model is one it has nothing to say about. Answering "never spent"
  // there would be the rule telling somebody to delete a name it never looked for — which is the
  // harm the leniency above exists to avoid, arriving through the one door left open to it.
  if (prefixes === undefined) return true

  return prefixes.some((prefix) => new RegExp(`\\b${prefix}-${tail}\\b`, 'u').test(classes))
}

/** Everywhere a class name can be written: a screen, or a stylesheet line that is not a definition. */
function classesIn(screens: readonly string[], stylesheets: readonly string[]): string {
  const notDefinitions = (path: string): string =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*--[a-z][a-z0-9-]*\s*:/u.test(line))
      .join('\n')

  const written = screens.map((path) => readFileSync(path, 'utf8'))

  return [...written, ...stylesheets.map(notDefinitions)].join('\n')
}

/**
 * Everything alive, spreading outward from the names something spends.
 *
 * A name is alive when something alive reads it, which is not the same as being read: a row whose
 * only reader is itself dead is dead along with it.
 */
function liveAmong(
  definitions: readonly Definition[],
  spent: ReadonlySet<string>,
): ReadonlySet<string> {
  const live = new Set(spent)
  let growing = true

  while (growing) {
    growing = false
    for (const one of definitions) {
      const fresh = live.has(one.name) ? one.reads.filter((name) => !live.has(name)) : []
      fresh.forEach((name) => live.add(name))
      growing ||= fresh.length > 0
    }
  }

  return live
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

  it('is defined only where it is read', () => {
    // The other direction, and the one nothing was watching: folding five palettes into one left
    // names behind that no screen ever asks for. They cost nothing to render and everything to
    // read — somebody choosing a colour has to decide, every time, whether the row they are
    // looking at is a colour this product uses or one it used to.
    const stylesheets = under(WEB, '.css')
    const screens = under(WEB, '.tsx')
    const classes = classesIn(screens, stylesheets)
    const read = stylesheets.map(readingIn)
    const definitions = read.flatMap((one) => one.definitions)
    const spent = new Set([
      ...read.flatMap((one) => one.uses),
      ...namesIn(REQUIRED, screens),
      ...definitions
        .filter((one) => one.themed && spentAsUtility(one.name, classes))
        .map((one) => one.name),
    ])
    const live = liveAmong(definitions, spent)

    const unread = definitions
      .map((one) => one.name)
      .filter((name) => !live.has(name) && !isTailwinds(name))

    expect([...new Set(unread)].sort()).toEqual([])
  })
})
