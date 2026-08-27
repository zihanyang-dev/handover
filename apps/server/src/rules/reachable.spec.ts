/**
 * That every endpoint this deployment has is one something can actually reach.
 *
 * An endpoint nobody calls is not dead code — knip cannot see it, because nothing imports it. It
 * is worse than dead: it is tested, documented, and promised, and the promise is false. This one
 * was written after `DELETE /spaces/{slug}/invitations/{id}` sat behind no screen for a whole
 * slice, while `prd.md` 05 ① said a link could be stopped.
 *
 * Reached means: called by the browser app, called by the machine's command, or named below as
 * something a browser or a provider walks into rather than a client calls.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONTRACT = 'apps/server/generated/openapi.json'

/**
 * The ones no generated client will ever mention, and why.
 *
 * Each is walked into by something that is not our code: a browser following a redirect, a
 * provider sending one back, or the very first call a machine makes before it has a client.
 */
const WALKED_INTO = new Set([
  // The browser is sent here by the provider, and arrives with a query string.
  '/auth/{provider}/callback',
])

/**
 * The same path written as a template literal, with anything at all in the holes.
 *
 * A caller that cannot use the generated client writes the parameters itself, and what it calls
 * them is its own business — so the hole matches whatever is in it rather than the name the
 * contract gave it.
 */
function asTemplate(path: string): RegExp {
  const escaped = path.replaceAll(/[.*+?^$()|[\]\\]/gu, String.raw`\$&`)

  return new RegExp(escaped.replaceAll(/\{[^}]+\}/gu, String.raw`\$\{[^}]+\}`), 'u')
}

function callers(): string {
  const found: string[] = []
  const walk = (from: string): void => {
    for (const entry of readdirSync(from)) {
      const path = join(from, entry)
      if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (/\.tsx?$/u.test(entry) && !entry.includes('.spec.'))
        found.push(readFileSync(path, 'utf8'))
    }
  }
  walk('apps/web')
  walk('apps/cli/src')

  return found.join('\n')
}

describe('the endpoints this deployment has', () => {
  it('are all reachable by somebody, rather than promised and unreachable', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      paths: Record<string, unknown>
    }
    const asked = callers()

    const unreachable = Object.keys(contract.paths)
      .filter((path) => !WALKED_INTO.has(path))
      // Two spellings: the path exactly as a typed client writes it, and the same path with its
      // parameters filled in by a template literal — which is what anything not going through the
      // generated client has to do. `EventSource` takes a URL, not a client call.
      .filter((path) => !asked.includes(`'${path}'`) && !asTemplate(path).test(asked))
      .sort()

    expect(unreachable).toEqual([])
  })
})
