/**
 * That every endpoint a design document names is one this deployment really has.
 *
 * The design is where somebody reads the shape of the API before writing a client, and it drifts
 * silently: a route is renamed here and the sentence over there still spells the old one. What
 * that costs is not a stale document — it is a client that follows the frozen design, gets a 404,
 * and has no way to tell which of the two is the current answer.
 *
 * Only this direction. A route absent from the docs is a gap somebody has to judge; a route the
 * docs *invent* is a lie, and that can be asked mechanically.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DOCS = 'docs/roadmap'

/** A line in a design that is offering a method and a path, rather than talking about one. */
const OFFERED = /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/u

/**
 * A slice that has been frozen and not built yet says so in its first lines.
 *
 * Those documents describe what is *going* to exist — that is the order the work happens in, and
 * holding them to what exists today would mean either not writing a design before the code or
 * writing one that lies by omission. What the rule is really about is a *delivered* slice whose
 * document drifted away from it.
 */
const NOT_BUILT = '还没实现'

function everyDesign(from = DOCS): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)

    return statSync(path).isDirectory() ? everyDesign(path) : path.endsWith('.md') ? [path] : []
  })
}

/** What the documents say can be called, as `METHOD /path`. */
function written(): readonly { readonly at: string; readonly said: string }[] {
  return everyDesign().flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, at, lines) => {
        if (lines.slice(0, 5).some((one) => one.includes(NOT_BUILT))) return []
        const found = OFFERED.exec(line)
        if (found === null) return []

        // Trailing punctuation and comments are prose, not path.
        const route = (found[2] ?? '').replace(/[,.;:)]+$/u, '')

        return [{ at: path, said: `${found[1] ?? ''} ${route}` }]
      }),
  )
}

/** What this deployment really answers, from the contract its own routes produce. */
function real(): ReadonlySet<string> {
  const contract = JSON.parse(readFileSync('apps/server/generated/openapi.json', 'utf8')) as {
    paths: Record<string, Record<string, unknown>>
  }

  return new Set(
    Object.entries(contract.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    ),
  )
}

describe('the endpoints a design names', () => {
  it('are all endpoints this deployment really has', async () => {
    const answered = real()

    expect(written().filter((one) => !answered.has(one.said))).toEqual([])
  })
})
