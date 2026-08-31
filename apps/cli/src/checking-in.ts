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
  sayItStartedOver,
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
import { prepareWorkspace } from './workspace.ts'

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
  /**
   * The folder each conversation gets one of its own under.
   *
   * It used to be this process's own directory — a machine ran one thing at a time, and that
   * thing ran where `handover connect` was typed. Several at once in one directory is the exact
   * failure that limit existed to prevent, so each turn now gets its own. See `workspace.ts`.
   */
  readonly workRoot: string
  /**
   * The directory this process is in, which is the one `handover connect` was run in.
   *
   * Reported, not used. Nothing runs here any more — every turn works in a folder of its own —
   * but `03` promised an agent works in your files, and the only way that promise survives is
   * for a person to be able to pick this directory when they open a conversation. A screen
   * cannot offer it without having been told it.
   */
  readonly connectedIn: string
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
      /** Every turn somebody asked this machine to stop working on. Empty nearly always. */
      readonly stopping: readonly Stopping[]
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
    /** The directory this machine was connected in, so a screen can offer it as "my project". */
    readonly connectedIn?: string
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
      ...(also.connectedIn === undefined ? {} : { connectedIn: also.connectedIn }),
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
  const asks = offering(running.env, running.workRoot)
  // Keyed by conversation, because that is what a question and a stop both name. A machine
  // answers several at once now; how many is the server's to decide, and it decides it per agent
  // rather than per machine — nothing here counts anything.
  const answering = new Map<string, Answering>()
  // Said once, on the first report. Anything still open on this machine then was left by whatever
  // ran before this process, and went on without anybody watching it.
  let restarted = true

  while (!stopping.aborted) {
    const reported = await reportOnce(api, looking, running.env, {
      restarted,
      offering: asks,
      connectedIn: running.connectedIn,
    })

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
    await beginAnswering(api, reported.asking, answering, { ...running, until: stopping })
    await waitBeforeReportingAgain(running, reported, stopped, stopping)
  }

  // Stopping on purpose stops the agent too, and waits for the last of what it said to be written
  // down. A turn abandoned here would be one nobody can say the outcome of, and the measured
  // difference between asking an agent to stop and being killed is exactly that.
  await settle(answering, running)

  return { kind: 'asked-to-stop' }
}

/**
 * Starts what this report handed out and holds it until it is over.
 *
 * The loop's bookkeeping around `startAnswering`, which is the turn's own. What this owns is the
 * map: an answer goes in before anything can settle it and comes out only when that same one
 * finishes.
 *
 * Reporting carries on either way: a turn can take ten minutes, and a machine that goes quiet for
 * ten minutes is one its Space shows as gone.
 *
 * One question per answer, still, and one started per report — the server hands out one at a time
 * and the loop asks again a second later, so a machine allowed three is answering three within
 * three seconds. Guarded on the conversation because being handed one that is already being
 * answered is the server having answered before this machine's last claim was written down.
 */
async function beginAnswering(
  api: Api,
  asking: Asking | undefined,
  answering: Map<string, Answering>,
  machine: Machine,
): Promise<void> {
  if (asking === undefined || answering.has(asking.conversationId)) return

  const started = await answer(api, asking, machine)
  // Held before anything is hung off it finishing. A turn that is over before this line runs —
  // a write that failed on the first try, an agent this build cannot run — would otherwise take
  // itself out of a map it was not in yet, and then be put in and left there: the conversation
  // reads as being answered for the rest of this process's life, and every question the server
  // hands out for it is dropped on the floor. Which is the failure this whole map replaced.
  answering.set(asking.conversationId, started)

  const over = (): void => {
    // Only if it is still this one. Nothing today can replace an entry before it settles, and
    // an ending that took out its successor would be exactly the same bug the other way round.
    if (answering.get(asking.conversationId) === started) answering.delete(asking.conversationId)
  }
  void started.done.then(over, over)
}

/**
 * How long before asking again.
 *
 * Nothing more can be learnt from asking until a turn that was stopped actually ends, so that is
 * what is waited on — and the next question is picked up the moment one does.
 */
async function waitBeforeReportingAgain(
  running: CheckingIn,
  reported: Extract<Reported, { said: 'here' }>,
  stopped: readonly Answering[],
  stopping: AbortSignal,
): Promise<void> {
  if (stopped.length === 0) {
    return running.sleep(Math.max(reported.pollSeconds, AT_LEAST_SECONDS), stopping)
  }

  await Promise.race([
    ...stopped.map(async (one) => one.done),
    running.sleep(WHILE_STOPPING_SECONDS, stopping),
  ])
}

/**
 * Passes on every request to stop that is about a turn this machine is on, and says which.
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
  answering: ReadonlyMap<string, Answering>,
  wanted: readonly Stopping[],
  say: (line: string) => void,
): Promise<readonly Answering[]> {
  const stopping = wanted
    .map((one) => ({ one, running: answering.get(one.conversationId) }))
    // The turn and not just the conversation. A stop is read out of the tables a moment before it
    // is acted on, and in that moment the turn it was about can end and the next one begin — on
    // the same conversation, because interrupting is how the next one got there. Matched loosely,
    // the interrupt stops the answer it was making room for.
    .filter((both) => both.running !== undefined && both.running.afterSeq === both.one.afterSeq)
    .map((both) => both.running as Answering)

  for (const one of stopping) {
    say(`stopping ${one.conversationId}`)
    await one.stop()
  }

  return stopping
}

/**
 * A machine its owner has disconnected, on its way out.
 *
 * The agent is still running, and this process is about to exit. Left alone it becomes an orphan:
 * nobody watching, still changing files in somebody's project, still spending their subscription.
 */
async function taken(
  answering: ReadonlyMap<string, Answering>,
  running: CheckingIn,
): Promise<Stopped> {
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
async function answer(api: Api, asking: Asking, machine: Machine): Promise<Answering> {
  // The agent is found afresh for every turn, and this is where the turn's own name goes into the
  // environment it will run in. `handover task` reads it, so nothing has to be typed or guessed:
  // an agent says "I am waiting on you" about *this* conversation because that is the only one it
  // was told about.
  const agent = agentFor(asking.agentKind, {
    ...machine.env,
    HANDOVER_CONVERSATION: asking.conversationId,
  })

  return starting(api, asking, machine, agent)
}

/**
 * The turn, or the one line saying why there is not one.
 *
 * Two ways it cannot begin, and both have to come back as a turn that ended saying so rather than
 * as a question that sits unanswered with nobody able to explain it. An agent this build has no
 * adapter for is the ordinary way an older machine meets a newer deployment; a directory that is
 * not there is a person having typed one that is not.
 */
async function starting(
  api: Api,
  asking: Asking,
  machine: Machine,
  agent: ReturnType<typeof agentFor>,
): Promise<Answering> {
  if (agent === undefined) {
    machine.say(`cannot run ${asking.agentKind} on this machine`)

    return cannot(api, asking, machine, `This machine cannot run ${asking.agentKind}.`)
  }

  const workspace = await prepareWorkspace(asking, machine.workRoot)

  if (workspace.startedOver) {
    machine.say(`nothing left in ${workspace.path}; starting over`)
    await sayItStartedOver(api, asking, machine)
  }

  machine.say(`answering in ${asking.conversationId}, in ${workspace.path}`)

  return startAnswering(api, asking, agent, { machine, where: workspace.path })
}

function cannot(api: Api, asking: Asking, machine: Machine, text: string): Answering {
  return {
    conversationId: asking.conversationId,
    afterSeq: asking.afterSeq,
    stop: async () => {
      // Nothing was ever started, so there is nothing to stop. Saying so is the whole answer.
    },
    done: endTurn(api, asking, machine, { activityType: 'failed', text }),
  }
}

async function settle(
  answering: ReadonlyMap<string, Answering>,
  running: CheckingIn,
): Promise<void> {
  // Taken once, before anything is stopped. Read again afterwards it would be a different map:
  // an answer that ends while the others are being asked to stop takes itself out of it, and
  // what is then waited on is everything except the one that was closest to finishing.
  const all = [...answering.values()]
  if (all.length === 0) return

  running.say('stopping what the agents were doing')
  // All of them asked to stop first, and only then waited on. One at a time, every agent after
  // the first would be left running for as long as the one before it took to wind down — and
  // what is winding down here is a process that is about to be killed.
  await Promise.all(all.map(async (one) => one.stop()))
  await Promise.all(all.map(async (one) => one.done))
}
