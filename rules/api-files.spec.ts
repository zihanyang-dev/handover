/**
 * That every `-api.ts` is laid out the same way.
 *
 * A module's file answers three questions in order: what it needs, what it can say, and what it
 * does. Read in that order a stranger can stop after the second and still know the shape of the
 * module — which is exactly what somebody writing a client wants and never has to run anything
 * to get.
 *
 * The order drifts the moment two files are merged: one file's vocabulary lands after the other's
 * routes, and nothing says so. It happened in this repository twice in one afternoon, which is
 * why it is asked here rather than remembered.
 *
 * Two things are asked. **Nothing but imports, types and constants stands before the function
 * that lists the routes** — a schema built inside a route is caught by the same sentence. And
 * **a module names what it needs**, as one type, rather than taking a database and leaving the
 * next thing it needs to be threaded through by hand.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = 'apps/server/src/server'

/** The word each top-level line begins with, once its doc comment is set aside. */
const DECLARES =
  /^(export type|type|export const|const|export function|function|async function|import)\b/u

/** What may be said before the route list, and nothing else. */
const BEFORE = new Set(['import', 'type', 'export type', 'const', 'export const'])

function outOfOrder(source: string, api: string): readonly string[] {
  const said: string[] = []
  for (const line of source.split('\n')) {
    const found = DECLARES.exec(line)
    if (found === null) continue
    if (line.startsWith(`export function ${api}(`)) break

    said.push(found[1] ?? '')
  }

  return said.filter((one) => !BEFORE.has(one))
}

/**
 * Whether this file says what it needs as a type of its own.
 *
 * `spaceApi(db: Database)` works until the day it needs a second thing, and then every caller
 * changes. Naming it once is also the only place a reader can see what a module depends on
 * without reading all of it.
 *
 * Read out of the signature rather than worked out from the function's name: `oauthApi` takes an
 * `OAuthApi`, and a rule that capitalises the first letter would call that wrong.
 */
function namesWhatItNeeds(source: string, api: string): boolean {
  const takes = new RegExp(`export function ${api}\\(\\w+: (\\w+Api)\\)`, 'u').exec(source)?.[1]

  return takes !== undefined && source.includes(`export type ${takes} = `)
}

/** What this file says out of turn, if anything. */
function misplaced(entry: string): readonly string[] {
  const source = readFileSync(join(SOURCE, entry), 'utf8')
  const api = /export function (\w+Api)\(/u.exec(source)?.[1]
  if (api === undefined) return [`${entry}: no route list`]

  const said = outOfOrder(source, api).map((one) => `${entry}: ${one} before ${api}()`)

  return namesWhatItNeeds(source, api) ? said : [...said, `${entry}: no type saying what it needs`]
}

describe('the shape of an api file', () => {
  it('says what it needs and what it can say before it says what it does', () => {
    const files = readdirSync(SOURCE).filter((entry) => entry.endsWith('-api.ts'))

    expect(files.flatMap(misplaced)).toEqual([])
  })
})
