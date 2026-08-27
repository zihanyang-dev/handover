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

import type { Model } from './agents/agent.ts'
import { agentForCommand } from './agents/known-agents.ts'
import type { Found } from './discovery.ts'

/** What is reported: what was found, and — the first time each version is seen — what it offers. */
type Offered = Found & { readonly models?: Model[] }

export type Offering = (found: readonly Found[]) => Promise<readonly Offered[]>

/**
 * Long enough for a cold binary that has to start, short enough that a machine which would
 * otherwise be perfectly usable is not held back waiting to learn something optional.
 */
const ANSWER_WITHIN_MS = 15_000

/**
 * What one agent offers, or nothing at all.
 *
 * Never throws and never hangs. A model list is an optional convenience; being reported at all is
 * not. An agent installed but not signed in, an SDK that fails, a CLI that never answers — each of
 * those would otherwise take down the whole report, and the Space would show a machine that is
 * running as gone.
 */
async function offeredBy(command: string, env: NodeJS.ProcessEnv, where: string) {
  const agent = agentForCommand(command, env)
  if (agent === undefined) return []

  const giveUp = new Promise<readonly Model[]>((settle) => {
    setTimeout(() => {
      settle([])
    }, ANSWER_WITHIN_MS).unref()
  })

  return Promise.race([agent.offers(where), giveUp]).catch(() => [])
}

export function offering(env: NodeJS.ProcessEnv, where: string): Offering {
  const asked = new Map<string, string>()

  return async (found) =>
    Promise.all(
      found.map(async (one) => {
        if (asked.get(one.command) === one.version) return one

        const models = [...(await offeredBy(one.command, env, where))]
        // Remembered whatever came back, including nothing: an agent that cannot answer is not
        // one to ask again every twenty-five seconds. The next version is the next time to ask.
        asked.set(one.command, one.version)

        return { ...one, models }
      }),
    )
}
