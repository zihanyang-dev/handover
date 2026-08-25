/**
 * Staying connected: report what is here, wait, report again.
 *
 * The loop is the whole of being online. There is no separate heartbeat — a machine that has
 * nothing to say still says it, and that is what the server counts as being here.
 */

import type { Api } from './api.ts'
import { findAgents, type Found } from './discovery.ts'

/** Short enough that a blip is invisible, long enough not to hammer a server that is down. */
const RETRY_SECONDS = 5

export type CheckingIn = {
  /**
   * Waits, and stops waiting the moment the signal says so.
   *
   * The second half is not a nicety. Stopping a service is a SIGTERM and then a kill a few
   * seconds later; a loop that only notices when its twenty-five second sleep ends is killed
   * before it can say goodbye, and the Space goes on showing the machine as here until the
   * silence has run long enough to count.
   */
  readonly sleep: (seconds: number, until: AbortSignal) => Promise<void>
  /** Told when something changed, so a person watching a terminal sees why it went quiet. */
  readonly say: (line: string) => void
  readonly env: NodeJS.ProcessEnv
}

/**
 * What one report came back as.
 *
 * Three states, and the third is not folded into either of the others: a server that did not
 * answer has not turned this machine away, and treating it as though it had would throw away a
 * working credential over a dropped Wi-Fi.
 */
export type Reported =
  | {
      readonly said: 'here'
      readonly found: readonly Found[]
      readonly lookFor: readonly string[]
      readonly pollSeconds: number
    }
  /** The server does not know this credential. Nothing to retry — somebody has to enrol again. */
  | { readonly said: 'not-ours' }
  | { readonly said: 'unreachable'; readonly found: readonly Found[] }

/**
 * Looks, reports, and says what came of it.
 *
 * The report is also the question "am I still in": there is no separate endpoint for asking, and
 * there should not be — one that could disagree with this one would be a second truth.
 */
export async function reportOnce(
  api: Api,
  lookFor: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Reported> {
  const found = await findAgents(lookFor, env)
  const came = await api.POST('/machines/current/poll', { body: { found } })

  if (came.response.status === 401) return { said: 'not-ours' }
  if (came.data === undefined) return { said: 'unreachable', found }

  return { said: 'here', found, lookFor: came.data.lookFor, pollSeconds: came.data.pollSeconds }
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
    const reported = await reportOnce(api, looking, running.env)

    if (reported.said === 'not-ours') return { kind: 'removed' }

    if (reported.said === 'unreachable') {
      running.say('cannot reach the server; still trying')
      await running.sleep(RETRY_SECONDS, stopping)
      continue
    }

    looking = reported.lookFor
    await running.sleep(reported.pollSeconds, stopping)
  }

  return { kind: 'asked-to-stop' }
}
