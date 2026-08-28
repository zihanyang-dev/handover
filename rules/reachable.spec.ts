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
  // A face is fetched by the browser's own `<img>`, from a URL the server put in a response. No
  // generated client will ever name it, and a page that fetched it through one would be throwing
  // away the image cache that makes it worth serving this way.
  '/avatars/users/{userId}',
  '/avatars/agents/{machineId}/{agentKind}',
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

/**
 * Promised, and with no screen in front of it yet.
 *
 * These are not walked into by anything — nobody can reach them, and each one is a promise this
 * build does not keep. They are here because the browser app was rebuilt as one slice (sign in,
 * make a Space, connect a machine, talk to an agent) and the screens that used to reach them have
 * not been rebuilt yet. The server side of each still works and is tested.
 *
 * **This list may only ever get shorter.** Anything added to it is a route somebody wrote with
 * nowhere to press, and the honest thing then is not to write the route.
 */
const NO_SCREEN_YET = new Set([
  // Disconnecting a machine, and naming an agent on one. The machines screen the rebuild removed
  // had both; the rebuilt sidebar lists machines and their agents but offers nothing to press.
  '/me/machines/{id}',
  '/me/machines/{id}/agents/{kind}',
  // Handing a conversation over as a piece of work, and taking it back.
  '/spaces/{slug}/conversations/{id}/task',
  // Saying you are typing. Nothing on the rebuilt chat shows the other person's name.
  '/spaces/{slug}/conversations/{id}/typing',
  // Everything the People screen did: inviting, stopping a link, changing a role, removing
  // somebody, and reading what they still hold.
  '/spaces/{slug}/invitations',
  '/spaces/{slug}/invitations/{id}',
  '/spaces/{slug}/machines/{id}',
  '/spaces/{slug}/members/{userId}',
  '/spaces/{slug}/members/{userId}/held',
])

describe('the endpoints this deployment has', () => {
  it('are all reachable by somebody, rather than promised and unreachable', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      paths: Record<string, unknown>
    }
    const asked = callers()

    const unreachable = Object.keys(contract.paths)
      .filter((path) => !WALKED_INTO.has(path) && !NO_SCREEN_YET.has(path))
      // Two spellings: the path exactly as a typed client writes it, and the same path with its
      // parameters filled in by a template literal — which is what anything not going through the
      // generated client has to do. `EventSource` takes a URL, not a client call.
      .filter((path) => !asked.includes(`'${path}'`) && !asTemplate(path).test(asked))
      .sort()

    expect(unreachable).toEqual([])
  })
})
