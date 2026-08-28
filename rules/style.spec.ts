/**
 * That a class a screen names is one that ends up meaning something.
 *
 * It drifts silently: a renamed rule, a typo, or a utility Tailwind does not recognise renders as
 * nothing at all — which reads as a layout bug rather than as a name nobody defined. It shows up
 * in no type, no test, and no screenshot of the happy path.
 *
 * Measured against the **built** stylesheet rather than the source, because most of what a screen
 * names is no longer written down anywhere: Tailwind generates a utility on seeing it used, so
 * the source has no `.flex` to find and `.flx` would be just as absent. What the build emits is
 * the one place both kinds are answered — the rules we wrote, and the ones it wrote for us.
 *
 * It reads a build rather than making one. `pnpm check` builds once, before the tests; a rule that
 * built for itself would spawn pnpm, node and vite from inside a vitest worker, and there are as
 * many of those as this machine has cores.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/** Every class the built stylesheets carry, ignoring what they say about them. */
function built(): ReadonlySet<string> {
  const assets = join(WEB, 'dist', 'assets')
  if (!existsSync(assets)) {
    throw new Error('nothing is built: run `pnpm build` first, which `pnpm check` does for you')
  }

  const sheets = readdirSync(assets)
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => readFileSync(join(assets, entry), 'utf8'))
    .join('\n')

  // Escaped the way CSS needs them — `.h-1\.5`, `.bg-primary\/10` — and read back as written.
  return new Set(
    [...sheets.matchAll(/\.((?:[\w-]|\\.)+)/g)].map((found) =>
      (found[1] ?? '').replaceAll('\\', ''),
    ),
  )
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
  it('have something for every class a screen names', () => {
    const known = built()

    expect([...named()].filter((one) => !known.has(one))).toEqual([])
  })
})
