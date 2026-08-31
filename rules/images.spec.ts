/**
 * That the two compose files pin the same versions of the things they share.
 *
 * There are two on purpose. The one at the root is for a laptop: it publishes ports so a person
 * can open a database client, and its passwords are in the file for everybody to read. The one in
 * `deploy/` is the machine this runs on: no ports at all, values from a file that is not in the
 * repository, and two services the other one has never heard of. Merging them would mean an
 * override that *removes* a published port, which compose cannot do cleanly — and the failure of
 * getting that wrong is a production database on the open internet.
 *
 * What they do share is `db` and `objects`, and those were pinned by hand in two places with
 * nothing holding them together. Equal today, and equal only because somebody remembered twice.
 * The day they are not, `pnpm check` passes against one Postgres and the deployment runs another,
 * and the first word anybody gets is from production.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** `image: postgres:17.11-alpine` → `postgres` and the tag it is pinned to. */
const PINNED = /^\s*image:\s*(\S+?):(\S+)\s*$/gmu

function pinsIn(path: string): ReadonlyMap<string, string> {
  const source = readFileSync(path, 'utf8')

  return new Map([...source.matchAll(PINNED)].map((found) => [found[1] ?? '', found[2] ?? '']))
}

describe('the two compose files', () => {
  it('pin the same version of everything they both run', () => {
    const laptop = pinsIn('compose.yml')
    const deployed = pinsIn('deploy/compose.yml')

    const shared = [...laptop.keys()].filter((image) => deployed.has(image))
    // If this is ever empty the rule has stopped asking anything, which is worse than failing.
    expect(shared.length).toBeGreaterThan(0)

    expect(shared.map((image) => `${image}:${laptop.get(image) ?? ''}`)).toEqual(
      shared.map((image) => `${image}:${deployed.get(image) ?? ''}`),
    )
  })
})
