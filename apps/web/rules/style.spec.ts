/**
 * That a class a screen names is one a stylesheet has heard of.
 *
 * It drifts silently: a renamed rule, or a typo, renders as nothing at all — which reads as a
 * layout bug rather than as a name nobody defined. It shows up in no type, no test, and no
 * screenshot of the happy path.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = 'apps/web'

function under(from: string, keep: (path: string) => boolean): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    const path = join(from, entry)

    if (statSync(path).isDirectory()) return under(path, keep)

    return keep(path) ? [path] : []
  })
}

const screens = (): readonly string[] =>
  under(WEB, (path) => path.endsWith('.tsx') && !path.endsWith('.spec.tsx'))

/** Every class any stylesheet defines, ignoring what it says about them. */
function defined(): ReadonlySet<string> {
  const sheets = under(WEB, (path) => path.endsWith('.css'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  return new Set([...sheets.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((found) => found[1] ?? ''))
}

/** What one screen plainly puts on a `className`, with anything computed left out. */
function namedIn(source: string): readonly string[] {
  return [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((found) => `${found[1] ?? ''} ${(found[2] ?? '').replace(/\$\{[^}]*\}/g, ' ')}`)
    .flatMap((both) => both.split(/[\s'"]+/))
    .filter((one) => one !== '')
}

/** The narrow reading, across every screen. Narrow because a false name here would be a lie. */
function named(): ReadonlySet<string> {
  return new Set(screens().flatMap((path) => namedIn(readFileSync(path, 'utf8'))))
}

describe('the stylesheets and the screens', () => {
  // Only this direction. The other one — a class no screen asks for — cannot be asked
  // mechanically without lying: a name reaches an element through a template, an array that is
  // joined, or a helper, and half of those read as unused. A rule that cries wolf teaches people
  // to edit its list without looking, which is worse than not having it.
  it('have something for every class a screen names', async () => {
    const known = defined()

    expect([...named()].filter((one) => !known.has(one))).toEqual([])
  })
})
