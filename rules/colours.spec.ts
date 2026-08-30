/**
 * That a colour is defined in a stylesheet and only ever *named* on a screen.
 *
 * A stylesheet is where a colour may be a value. A screen is where it may only be a word — that
 * is the whole of `repository.md`'s split, and it is what makes a palette a palette rather than a
 * pile of similar greys.
 *
 * Written after counting. Two hundred hex colours had been typed straight into eight screens,
 * fifty-five of them distinct, and they were a third ink ramp beside the two `style.css` already
 * names and already calls one ramp too many. `#777570` appeared nineteen times. Nothing said the
 * screens had stopped using the tokens, because nothing was looking: it type-checks, it renders,
 * and every one of them is individually reasonable.
 *
 * Two things also came out of it that only a count makes visible — the same screens drew focus
 * rings in `--primary` and filled primary buttons with `--focus`, exactly the two tokens the other
 * way round.
 *
 * A brand mark is not a colour of ours. GitHub's ink and Google's four are that company's, they
 * arrive as an SVG `fill`, and a token for them would be a token nothing else may ever use — so
 * an attribute on a path is allowed, and everything else is on a list somebody has to edit.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = 'apps/web'

/** `#rgb`, `#rrggbb`, and the functional forms. */
const A_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/gu

/** A brand's own ink, painted straight onto a path. */
const PAINTED = /(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/gu

/**
 * The ones that are not the product's palette, each with why.
 *
 * Hand-edited on purpose, like `sql.spec.ts`'s: adding one costs somebody a deliberate visit
 * here, which is the point. Kept short — a long list is this rule being turned off slowly.
 */
const NOT_THE_PALETTE: Readonly<Record<string, string>> = {
  'apps/web/mark.tsx': 'the wordmark itself, whose ink belongs to it and to nothing else',
  'apps/web/components/ui/confetti-burst.ts':
    'paper thrown at a canvas; it is decoration, not a step on any ramp',
  'apps/web/components/ui/gradient-blur.tsx':
    'the colour a caller fades a blur towards, which is its argument rather than its own',
}

function under(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    const path = join(from, entry)

    if (statSync(path).isDirectory()) return under(path)

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

function writtenIn(path: string): readonly string[] {
  const source = readFileSync(path, 'utf8').replaceAll(PAINTED, '')

  return [...source.matchAll(A_COLOUR)].map((one) => `${path}: ${one[0]}`)
}

describe('a colour', () => {
  it('is written in a stylesheet and only named on a screen', () => {
    const screens = under(WEB).filter((path) => !(path in NOT_THE_PALETTE))

    expect(screens.flatMap(writtenIn)).toEqual([])
  })
})
