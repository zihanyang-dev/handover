/**
 * Asking each agent what it lets a person choose — as rarely as that can be asked.
 *
 * Asking costs starting the agent up: a whole CLI process, once per agent. Doing it on every
 * check-in would be this program starting two processes every twenty-five seconds forever, to
 * learn the same answer every time.
 *
 * So it is asked when the answer can have changed, which is when the version changed — a model
 * list is a thing a version can do. A machine that has just started has nothing remembered and
 * asks once; after that it stays quiet until an agent is upgraded.
 *
 * The cost of that is stated where it is felt: install a model that a version already on this
 * machine can use, and it will not be offered until that agent is upgraded. A model list is what
 * a version can do, not what happened in the last minute.
 */

import { agentForCommand } from './agents/known-agents.ts'
import type { Model } from './agents/agent.ts'
import type { Found } from './discovery.ts'

/** What is reported: what was found, and — the first time each version is seen — what it offers. */
export type Offered = Found & { readonly models?: Model[] }

export type Offering = (found: readonly Found[]) => Promise<readonly Offered[]>

/**
 * Remembers per command rather than per kind, because that is what was actually run: two commands
 * are two binaries, whatever the server calls them.
 */
export function offering(env: NodeJS.ProcessEnv, where: string): Offering {
  const asked = new Map<string, string>()

  return async (found) =>
    Promise.all(
      found.map(async (one) => {
        if (asked.get(one.command) === one.version) return one

        const agent = agentForCommand(one.command, env)
        // Nothing to ask, and nothing to keep asking: a command this machine has no adapter for
        // is one it will never drive, so it is remembered as answered rather than retried forever.
        const models = agent === undefined ? [] : [...(await agent.offers(where))]
        asked.set(one.command, one.version)

        return { ...one, models }
      }),
    )
}
