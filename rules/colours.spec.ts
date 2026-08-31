/**
 * That a colour is written in the palette and only ever *named* everywhere else.
 *
 * `apps/web/style.css` is where a colour may be a value. A screen is where it may only be a word
 * — and so, now, is every other stylesheet, which is the half of this rule that was missing.
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
 * Stylesheets were added to it after the palette was folded from five families into one. The
 * rule had only ever read `.ts` and `.tsx`, so a stylesheet could write whatever it liked — and
 * one had: `styles/chat.css` arrived as vendored markup carrying Ant Design's palette, which is
 * why a link in a conversation was `#1677ff` while every other link in the product was `#0075de`.
 * Four more families had grown the same way. Sixty-one colours were written across seven
 * stylesheets where the rule could not see them, six of them separate alphas of the one blue.
 *
 * A surface may still re-answer a name inside its own scope — that is what `.auth` is for — but
 * it costs a line here, because a scoped override is a design decision and this is where the ones
 * that have been made are listed.
 *
 * A brand mark is not a colour of ours. GitHub's ink and Google's four are that company's, they
 * arrive as an SVG `fill`, and a token for them would be a token nothing else may ever use — so
 * an attribute on a path is allowed, and everything else is on a list somebody has to edit.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = 'apps/web'

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and the functional forms.
 *
 * Those four lengths and no others, because those are the only ones CSS has. Written `{3,8}` it
 * also matched five and seven digits, which no colour is — and the first thing it caught that way
 * was `#13576`, a pull request somebody had cited in a comment.
 */
const A_COLOUR =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/gu

/** The same, without `color-mix`: what makes a mix a literal rather than a reference. */
const A_LITERAL = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba?|hsla?|oklch)\(/u

/**
 * A colour mixed from a named one is still named.
 *
 * `color-mix(in srgb, var(--primary) 18%, transparent)` is how the palette says "that blue, more
 * quietly" without writing a fourth blue down. One that mixes a literal is not — it is a colour
 * wearing a function — so the match is kept and the surrounding call is not.
 */
const DERIVED = /color-mix\((?:[^()]|\([^()]*\))*\)/gu

/** A brand's own ink, painted straight onto a path. */
const PAINTED = /(?:fill|stroke)="#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})"/gu

/**
 * A scoped surface re-answering a palette name, on the line that answers it.
 *
 * `.auth`'s hairline is black at low alpha rather than the palette's solid grey, because it sits
 * on a gradient and a solid line bands against it. That is a value, so it is written; every other
 * name the way in used to re-answer was the palette's own colour a step away, and went.
 */
const SCOPED = /^\s*--line:\s*#0000001f;$/u

/**
 * The ones that are not the product's palette, each with why.
 *
 * Hand-edited on purpose, like `sql.spec.ts`'s: adding one costs somebody a deliberate visit
 * here, which is the point. Kept short — a long list is this rule being turned off slowly.
 */
const NOT_THE_PALETTE: Readonly<Record<string, string>> = {
  'apps/web/style.css': 'the palette itself, which is the one place a colour is a value',
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

    return path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.css') ? [path] : []
  })
}

function writtenIn(path: string): readonly string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !SCOPED.test(line))
    .map((line) => line.replaceAll(PAINTED, ''))
    .map((line) => line.replaceAll(DERIVED, (mixed) => (A_LITERAL.test(mixed) ? mixed : '')))
    .flatMap((line) => [...line.matchAll(A_COLOUR)])
    .map((one) => `${path}: ${one[0]}`)
}

describe('a colour', () => {
  it('is written in the palette and only named everywhere else', () => {
    const screens = under(WEB).filter((path) => !(path in NOT_THE_PALETTE))

    expect(screens.flatMap(writtenIn)).toEqual([])
  })
})
