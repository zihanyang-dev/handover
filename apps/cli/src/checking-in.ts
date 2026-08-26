/**
 * Being a machine that is online: report what is here, hear what is wanted, do it, report again.
 *
 * The loop is the whole of it. There is no separate heartbeat — a machine that has nothing to say
 * still says it, and that is what the server counts as being here — and no separate channel for
 * work: a machine is reached by nothing but its own asking, so everything it is ever told arrives
 * in the answer to a report it was already making.
 */

import {
  endTurn,
  startAnswering,
  type Answering,
  type Asking,
  type Machine,
  type Stopping,
} from './answering.ts'
import { agentFor } from './agents/known-agents.ts'
import type { Api } from './api.ts'
import { findAgents, type Found } from './discovery.ts'
import { VERSION } from './env.ts'
import { offering, type Offering } from './offering.ts'

/** Short enough that a blip is invisible, long enough not to hammer a server that is down. */
const RETRY_SECONDS = 5

/**
 * How often to report while an agent is working.
 *
 * The deployment sets the resting rate, and this is a floor under it for the one time a machine
 * has something to hear: somebody who asks an agent to stop is watching it, and the answer to
 * "why is it still going" cannot be "it will find out in twenty-five seconds". Reporting costs
 * nothing here — the machine is already awake, holding a running agent.
 */
const WHILE_WORKING_SECONDS = 3

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
  /** Where an agent works: this process's own directory, which is where it was connected. */
  readonly where: string
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
      /** One question waiting on this machine, when there is one. */
      readonly asking: Asking | undefined
      /** The turn somebody asked this machine to stop working on. */
      readonly stopping: Stopping | undefined
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
  also: {
    /** Said once, on the first report a process makes. Only this machine can know it. */
    readonly restarted?: boolean
    /** Adds what each agent offers, the first time this process sees each version. */
    readonly offering?: Offering
  } = {},
): Promise<Reported> {
  const looked = await findAgents(lookFor, env)
  const found = also.offering === undefined ? looked : await also.offering(looked)
  const came = await api.POST('/machines/current/poll', {
    // Its own version goes with every report, not once at connect: the binary can be replaced
    // between two reports by a person re-running the installer, and the answer to "which build is
    // that machine running" has to be about the process that is running now.
    body: {
      found: [...found],
      restarted: also.restarted ?? false,
      version: VERSION,
    },
  })

  if (came.response.status === 401) return { said: 'not-ours' }
  if (came.data === undefined) return { said: 'unreachable', found }

  return {
    said: 'here',
    found,
    lookFor: came.data.lookFor,
    pollSeconds: came.data.pollSeconds,
    asking: came.data.asking,
    stopping: came.data.stopping,
  }
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
  // One per loop, because what it remembers is what this process has already asked.
  const asks = offering(running.env, running.where)
  let answering: Answering | undefined
  // Said once, on the first report. Anything still open on this machine then was left by whatever
  // ran before this process, and went on without anybody watching it.
  let restarted = true

  while (!stopping.aborted) {
    const reported = await reportOnce(api, looking, running.env, { restarted, offering: asks })

    if (reported.said === 'not-ours') return taken(answering, running)

    if (reported.said === 'unreachable') {
      // Still unsaid. A report nobody received did not tell the server this machine restarted, and
      // forgetting that here would leave whatever it left open working forever — the one thing
      // only this process can say, lost to a dropped connection.
      running.say('cannot reach the server; still trying')
      await running.sleep(RETRY_SECONDS, stopping)
      continue
    }

    restarted = false
    looking = reported.lookFor

    await stopIfAsked(answering, reported.stopping, running.say)

    // One at a time. Reporting carries on either way: a turn can take ten minutes, and a machine
    // that goes quiet for ten minutes is one its Space shows as gone.
    if (answering === undefined && reported.asking !== undefined) {
      answering = answer(api, reported.asking, { ...running, until: stopping }, () => {
        answering = undefined
      })
    }

    await running.sleep(waitFor(reported.pollSeconds, answering !== undefined), stopping)
  }

  // Stopping on purpose stops the agent too, and waits for the last of what it said to be written
  // down. A turn abandoned here would be one nobody can say the outcome of, and the measured
  // difference between asking an agent to stop and being killed is exactly that.
  await settle(answering, running)

  return { kind: 'asked-to-stop' }
}

/**
 * Passes on a request to stop, when it is about the turn this machine is on.
 *
 * Told on every report until the agent says it stopped, so a request made while this machine was
 * between reports arrives on the next one instead of being lost. `stop` is asked more than once
 * and means the same thing each time.
 */
/**
 * Stops the agent, if the stop that came back is about the turn it is on.
 *
 * Exported for its own tests: what it decides is a race that cannot be staged from outside — a
 * stop is read out of the tables a moment before it is acted on, and the whole rule is about what
 * may have changed in that moment.
 */
export async function stopIfAsked(
  answering: Answering | undefined,
  wanted: Stopping | undefined,
  say: (line: string) => void,
): Promise<void> {
  if (answering === undefined || wanted === undefined) return
  // The turn and not just the conversation. A stop is read out of the tables a moment before it
  // is acted on, and in that moment the turn it was about can end and the next one begin — on the
  // same conversation, because interrupting is how the next one got there. Matched loosely, the
  // interrupt stops the answer it was making room for.
  if (wanted.conversationId !== answering.conversationId) return
  if (wanted.askedSeq !== answering.askedSeq) return

  say(`stopping ${answering.conversationId}`)
  await answering.stop()
}

/**
 * A machine that has been taken out of its Space, on its way out.
 *
 * The agent is still running, and this process is about to exit. Left alone it becomes an orphan:
 * nobody watching, still changing files in somebody's project, still spending their subscription.
 */
async function taken(answering: Answering | undefined, running: CheckingIn): Promise<Stopped> {
  await settle(answering, running)

  return { kind: 'removed' }
}

/** Never slower than the deployment asked, and never slower than the floor while working. */
function waitFor(pollSeconds: number, busy: boolean): number {
  return busy ? Math.min(pollSeconds, WHILE_WORKING_SECONDS) : pollSeconds
}

/**
 * Takes one question, or says why this machine cannot.
 *
 * A machine with no adapter for an agent the server knows about is the ordinary way an older
 * machine meets a newer deployment. It has to come back as a turn that ended saying so, not as a
 * question that sits unanswered forever with nobody able to explain why.
 */
function answer(api: Api, asking: Asking, machine: Machine, over: () => void): Answering {
  const agent = agentFor(asking.agentKind, machine.env)
  machine.say(
    agent === undefined
      ? `cannot run ${asking.agentKind} on this machine`
      : `answering in ${asking.conversationId}`,
  )

  const started =
    agent === undefined ? cannot(api, asking, machine) : startAnswering(api, asking, agent, machine)

  void started.done.then(over, over)

  return started
}

function cannot(api: Api, asking: Asking, machine: Machine): Answering {
  const text = `This machine cannot run ${asking.agentKind}.`

  return {
    conversationId: asking.conversationId,
    askedSeq: asking.askedSeq,
    stop: async () => {
      // Nothing was ever started, so there is nothing to stop. Saying so is the whole answer.
    },
    done: endTurn(api, asking, machine, { activityType: 'failed', text }),
  }
}

async function settle(answering: Answering | undefined, running: CheckingIn): Promise<void> {
  if (answering === undefined) return

  running.say('stopping what the agent was doing')
  await answering.stop()
  await answering.done
}
