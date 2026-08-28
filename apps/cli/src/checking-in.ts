/**
 * Being a machine that is online: report what is here, hear what is wanted, do it, report again.
 *
 * The loop is the whole of it. There is no separate heartbeat — a machine that has nothing to say
 * still says it, and that is what the server counts as being here — and no separate channel for
 * work: a machine is reached by nothing but its own asking, so everything it is ever told arrives
 * in the answer to a report it was already making.
 */

import { agentFor } from './agents/known-agents.ts'
import {
  endTurn,
  startAnswering,
  type Answering,
  type Asking,
  type Machine,
  type Stopping,
} from './answering.ts'
import type { Api } from './api.ts'
import { findAgents, type Found } from './discovery.ts'
import { VERSION } from './env.ts'
import { offering, type Offering } from './offering.ts'

/** Short enough that a blip is invisible, long enough not to hammer a server that is down. */
const RETRY_SECONDS = 5

/**
 * How long to wait for a turn that was asked to stop, before reporting again anyway.
 *
 * A stop is the one thing the server answers at once instead of holding, and it goes on
 * answering it until the turn ends — so this loop has to pace itself, or it asks again as fast as
 * the network can answer for as long as the agent takes to wind down. What it waits on is the
 * turn itself, which costs nothing when the agent stops quickly; this is the floor under one that
 * does not, so a machine winding down still reports often enough to be counted as here.
 */
const WHILE_STOPPING_SECONDS = 3

/**
 * The least any two reports are ever apart.
 *
 * The server answers `pollSeconds: 0` because it has already waited — but it only waits when it
 * has nothing to say. Whatever it does have, it answers at once, and a machine that then waited
 * zero asks again immediately and is told the same thing, as fast as the network can carry it.
 * Two processes at full tilt, for as long as the answer stays the same.
 *
 * It is reachable: a stop is wanted for a turn this machine is not running — which is what a
 * person pressing Stop after the agent has already died looks like from here — and neither side
 * can end that turn until the machine says so.
 *
 * Costs nothing where the loop is doing its job. A held question comes back the moment there is
 * something, the agent is started, and only *then* is this second spent, before asking for a
 * question there is not yet.
 */
const AT_LEAST_SECONDS = 1

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
  /**
   * How to run this program again.
   *
   * Handed to the agent so it can say things back. Not named as `handover`, because that is an
   * assumption about a PATH nobody checked — see {@link howToRunThis}.
   */
  readonly handover: string
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
  /** Its owner disconnected it. Nothing to retry: a person has to connect it again. */
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

    const stopped = await stopIfAsked(answering, reported.stopping, running.say)

    // One at a time. Reporting carries on either way: a turn can take ten minutes, and a machine
    // that goes quiet for ten minutes is one its Space shows as gone.
    if (answering === undefined && reported.asking !== undefined) {
      answering = answer(api, reported.asking, { ...running, until: stopping }, () => {
        answering = undefined
      })
    }

    // Nothing more can be learnt from asking again until the turn that was stopped actually
    // ends, so that is what is waited on. The next question is picked up the moment it does.
    if (stopped === undefined) {
      await running.sleep(Math.max(reported.pollSeconds, AT_LEAST_SECONDS), stopping)
    } else await Promise.race([stopped.done, running.sleep(WHILE_STOPPING_SECONDS, stopping)])
  }

  // Stopping on purpose stops the agent too, and waits for the last of what it said to be written
  // down. A turn abandoned here would be one nobody can say the outcome of, and the measured
  // difference between asking an agent to stop and being killed is exactly that.
  await settle(answering, running)

  return { kind: 'asked-to-stop' }
}

/**
 * Passes on a request to stop, when it is about the turn this machine is on, and says which turn.
 *
 * Told on every report until the agent says it stopped, so a request made while this machine was
 * between reports arrives on the next one instead of being lost. `stop` is asked more than once
 * and means the same thing each time.
 *
 * Exported for its own tests: what it decides is a race that cannot be staged from outside — a
 * stop is read out of the tables a moment before it is acted on, and the whole rule is about what
 * may have changed in that moment.
 */
export async function stopIfAsked(
  answering: Answering | undefined,
  wanted: Stopping | undefined,
  say: (line: string) => void,
): Promise<Answering | undefined> {
  if (answering === undefined || wanted === undefined) return undefined
  // The turn and not just the conversation. A stop is read out of the tables a moment before it
  // is acted on, and in that moment the turn it was about can end and the next one begin — on the
  // same conversation, because interrupting is how the next one got there. Matched loosely, the
  // interrupt stops the answer it was making room for.
  if (wanted.conversationId !== answering.conversationId) return undefined
  if (wanted.afterSeq !== answering.afterSeq) return undefined

  say(`stopping ${answering.conversationId}`)
  await answering.stop()

  return answering
}

/**
 * A machine its owner has disconnected, on its way out.
 *
 * The agent is still running, and this process is about to exit. Left alone it becomes an orphan:
 * nobody watching, still changing files in somebody's project, still spending their subscription.
 */
async function taken(answering: Answering | undefined, running: CheckingIn): Promise<Stopped> {
  await settle(answering, running)

  return { kind: 'removed' }
}

/**
 * Takes one question, or says why this machine cannot.
 *
 * A machine with no adapter for an agent the server knows about is the ordinary way an older
 * machine meets a newer deployment. It has to come back as a turn that ended saying so, not as a
 * question that sits unanswered forever with nobody able to explain why.
 */
function answer(api: Api, asking: Asking, machine: Machine, over: () => void): Answering {
  // The agent is found afresh for every turn, and this is where the turn's own name goes into the
  // environment it will run in. `handover task` reads it, so nothing has to be typed or guessed:
  // an agent says "I am waiting on you" about *this* conversation because that is the only one it
  // was told about.
  const agent = agentFor(asking.agentKind, {
    ...machine.env,
    HANDOVER_CONVERSATION: asking.conversationId,
  })
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
    afterSeq: asking.afterSeq,
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
