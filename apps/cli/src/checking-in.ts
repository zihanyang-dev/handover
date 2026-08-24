/**
 * Staying connected: report what is here, wait, report again.
 *
 * The loop is the whole of being online. There is no separate heartbeat — a machine that has
 * nothing to say still says it, and that is what the server counts as being here.
 */

import { answered, type Api } from './api.ts'
import { findAgents } from './discovery.ts'

/** Short enough that a blip is invisible, long enough not to hammer a server that is down. */
const RETRY_SECONDS = 5

export type CheckingIn = {
  readonly sleep: (seconds: number) => Promise<void>
  /** Told when something changed, so a person watching a terminal sees why it went quiet. */
  readonly say: (line: string) => void
  readonly env: NodeJS.ProcessEnv
}

export type Stopped =
  /** The machine was taken out of its Space. Nothing to retry: a person has to enrol it again. */
  | { readonly kind: 'removed' }
  /** Asked to stop. It says goodbye so the Space shows it gone immediately. */
  | { readonly kind: 'asked-to-stop' }

/**
 * Reports until told to stop or taken away.
 *
 * A failed check-in is not a reason to stop. Networks come back, servers restart, laptops close
 * their lids — the machine keeps asking, and the Space shows it gone in the meantime.
 */
export async function keepCheckingIn(
  api: Api,
  lookFor: readonly string[],
  running: CheckingIn,
  stopping: AbortSignal,
): Promise<Stopped> {
  let looking = lookFor

  while (!stopping.aborted) {
    const found = await findAgents(looking, running.env)
    const came = await answered(api.POST('/machines/current/poll', { body: { found } }))

    if (came?.response.status === 401) return { kind: 'removed' }

    if (came?.data === undefined) {
      running.say('cannot reach the server; still trying')
      await running.sleep(RETRY_SECONDS)
      continue
    }

    looking = came.data.lookFor
    await running.sleep(came.data.pollSeconds)
  }

  return { kind: 'asked-to-stop' }
}
