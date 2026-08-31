/**
 * That the table of two names for one thing is still true of the code.
 *
 * `code-style.md` 3.5.1 allows a thing to be called one name on the wire and another on screen,
 * on the condition that the pair is written down. Nothing checked that the writing down stayed
 * true, and it had not: the row for `task` said the wire calls it that, while the schemas a client
 * is generated from said `WorkOpened`, `WorkTheyHold` and `HandWorkTo`. The row was written before
 * the thing it describes, and a review read the row instead of the code for an entire round.
 *
 * Three things are asked of every row, and each is a way it goes stale:
 *
 *   the wire still uses that name    — or somebody renamed it and the row now points at nothing
 *   the screen still says the other  — or the copy moved on and the row describes a screen that
 *                                      no longer exists
 *   the wire's name is not on screen — which is the split the table exists to prevent: the moment
 *                                      a person reads `enrolment` in a sentence, there is no pair
 *                                      any more, there is a leak
 *
 * What it cannot ask is whether the wire agrees with *itself*, because knowing that `WorkTheyHold`
 * and `/task` are the same concept needs a reader. That one stays a person's job.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TABLE = 'docs/code-style.md'
const WEB = 'apps/web'

/** A row of the table: two names and the reason they are not one. */
const ROW = /^(\w[\w-]*)\s{2,}([a-z][a-z ]*[a-z])\s{2,}\S/gmu

/**
 * What a person reads.
 *
 * Three shapes, because a sentence reaches a screen three ways: as the text of an element, as the
 * word a control answers to, and as a string handed to a component that will render it — the tabs
 * down the side of a Space are `label: 'Inbox'` in an array, and a rule that only read JSX text
 * would have said nothing about them. Found by making this assertion red on purpose and watching
 * it stay green.
 */
const READS = [
  />\s*([A-Z][^<>{}\n]{2,70}?)\s*</gu,
  /(?:aria-label|placeholder|title|label)=["{`]+([^"}`\n]{2,70})/gu,
  /\blabel:\s*'([^'\n]{2,70})'/gu,
]

function under(from: string, ends: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    const path = join(from, entry)

    if (statSync(path).isDirectory()) return under(path, ends)

    return path.endsWith(ends) && !path.endsWith(`.spec${ends}`) ? [path] : []
  })
}

/** Every name this product answers to over HTTP, plus the tables underneath. */
function theWire(): string {
  const spec = readFileSync('apps/server/generated/openapi.json', 'utf8')
  const contract = JSON.parse(spec) as {
    paths: Readonly<Record<string, unknown>>
    components: { schemas: Readonly<Record<string, unknown>> }
  }
  const tables = readFileSync('apps/server/generated/schema.sql', 'utf8')

  return [
    ...Object.keys(contract.paths),
    ...Object.keys(contract.components.schemas),
    ...[...tables.matchAll(/CREATE TABLE public\.(\w+)/gu)].map((one) => one[1] ?? ''),
  ].join(' ')
}

/** Every sentence a person is shown, as one string. */
function theScreen(): string {
  return under(WEB, '.tsx')
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8')

      return READS.flatMap((pattern) => [...source.matchAll(pattern)].map((one) => one[1] ?? ''))
    })
    .join('\n')
}

/** `invitations` and `invitation` are the same word to a reader; the table writes the plural. */
function singular(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word
}

describe('a thing called one name on the wire and another on screen', () => {
  it('is a pair the table still describes', () => {
    const rows = [...readFileSync(TABLE, 'utf8').matchAll(ROW)].map(
      (one) => [one[1] ?? '', one[2] ?? ''] as const,
    )
    expect(rows.length, 'the table was found and read').toBeGreaterThan(2)

    const wire = theWire()
    const screen = theScreen()

    const wrong = rows.flatMap(([onTheWire, onScreen]) => {
      const stem = singular(onTheWire)
      const asWord = new RegExp(String.raw`\b${stem}`, 'iu')

      return [
        asWord.test(wire) ? [] : [`${onTheWire}: nothing on the wire is called that any more`],
        new RegExp(String.raw`\b${onScreen}`, 'iu').test(screen)
          ? []
          : [`${onScreen}: no screen says that any more`],
        asWord.test(screen) ? [`${onTheWire}: a screen is showing the wire's name`] : [],
      ].flat()
    })

    expect(wrong).toEqual([])
  })
})
