/**
 * Machines that are already in: what they report, and what a Space screen sees.
 *
 * Two holders, two doors. A machine reports and leaves; a person looks and removes. Neither
 * credential opens the other's routes — the powers are different, and one door for both would be
 * the weaker of the two everywhere.
 */

import { z } from '@hono/zod-openapi'
import { avatarPath } from '../avatar.ts'
import { Models } from '../conversation/offers.ts'
import type { Database } from '../db/connection.ts'
import {
  checkIn,
  machinesIn,
  removeMachine,
  sayGoodbye,
  setAgentSettings,
  type Installed,
} from '../db/machine.ts'
import { handMachineTo } from '../db/membership.ts'
import { forgetStranded, stopsWantedOn, takeOne, type Taken } from '../db/turn.ts'
import {
  agentsFound,
  AGENT_COMMANDS,
  AGENT_KIND_NAMES,
  type AgentKind,
} from '../machine/agent-kind.ts'
import { AT_ONCE_AT_MOST } from '../machine/at-once.ts'
import type { Waiting } from '../machine/waiting.ts'
import { onTheWire, Presence } from '../machine/whereabouts.ts'
import { type Failure, UNAVAILABLE, refused } from './failure.ts'
import {
  aMachine,
  aMember,
  aPerson,
  anOwner,
  list,
  named,
  nothing,
  refuses,
  rowId,
  sends,
} from './route.ts'

export type MachineApi = {
  readonly db: Database
  /** The questions this instance is holding. Not a fact, so it is not in the database. */
  readonly waiting: Waiting
}

/**
 * Not a machine any more.
 *
 * The same answer the door gives, said again by the transaction that writes: a credential can stop
 * being one between the two, and the CLI already knows to stop for good when it hears this.
 */
const NOT_OURS: Failure<401> = { reason: 'no-machine', recovery: 'start-over', status: 401 }

/**
 * Whoever it was handed to is not here, or the machine is not there to hand over.
 *
 * One answer for both, because a handover is written in the statement that checks — and by the
 * time it comes back, "no rows" cannot say which. What to do about either is the same: look at
 * the screen again, which is showing what is actually true.
 */
const CANNOT_HAND_OVER: Failure<404> = {
  reason: 'cannot-hand-over',
  recovery: 'start-over',
  status: 404,
}

/**
 * One agent a machine found, reported by command name rather than by kind.
 *
 * It reports what it actually looked for. Names this deployment does not know are dropped rather
 * than refused: a newer CLI against an older server should be a machine with fewer agents, not a
 * machine that cannot check in.
 */
const Found = named('AgentFound', {
  command: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  /**
   * What this version lets a person choose.
   *
   * Absent on nearly every report, and that is the design: asking an agent costs starting it up,
   * so a machine asks only when the version it found is new. Absent means "nothing said about
   * it", which leaves whatever was stored — not "it offers nothing".
   */
  models: Models.optional(),
})

/** What a machine says about itself, every time it asks whether there is anything for it. */
const Report = named('MachineReport', {
  /** Everything it looked for and found. Fifty is far more than a machine has. */
  found: z.array(Found).max(50).readonly(),
  /**
   * This machine has just started.
   *
   * Only it can say so, and it is worth saying: a turn left open on a machine that has just
   * started is one whose agent went on working with nobody watching, and no answer about it can
   * be had from here.
   */
  restarted: z.boolean().optional(),
  /**
   * Which build of the CLI this is.
   *
   * Optional so that a machine older than this field can still check in — the same reason a
   * command this deployment does not know is dropped rather than refused. Absent is recorded as
   * absent: a machine that cannot say which build it is has answered the question.
   */
  version: z.string().min(1).max(100).optional(),
  /**
   * The directory this machine was connected in.
   *
   * Not where anything runs. It is the one directory a screen can offer as "my project" without
   * anybody typing a path — `03` promised that an agent works in your files, and `07` only keeps
   * that promise if somebody can still choose it. Optional for the same reason `version` is.
   */
  connectedIn: z.string().min(1).max(512).optional(),
})

/**
 * Everything a person said since the turn before, oldest first.
 *
 * A list because two people can each say something before either is answered, and both have to
 * reach the agent — one of them dropped is a message that sits on a screen looking queued and is
 * never answered. Empty on a turn nobody asked for.
 *
 * The same shape both ways: it is what a machine is told, and it is what a row is checked against
 * on the way out. Written twice, the check would eventually be checking something else.
 */
const Said = named('Said', { text: z.string(), who: z.string().nullable() })

/** All of them, oldest first. */
const EVERYTHING_SAID = z.array(Said).readonly()

/**
 * Where a turn works, as one of three things rather than two nullable paths beside each other.
 *
 * Written as two — a directory somebody named, and the conversation this one was opened for —
 * it was possible to say both, and the machine held the rule that one of them wins. Two facts
 * with a precedence between them is one fact said badly: the rule lived on the machine, where
 * neither of them is decided, and saying both was a silent answer rather than a refused one.
 *
 * Every case is still the machine's to turn into a path. This says which question it is
 * answering, not where anything is.
 */
const WhereToWork = z
  .discriminatedUnion('kind', [
    /** Nobody said. A folder of its own, named after this conversation. */
    z.object({ kind: z.literal('its-own') }),
    /** A person pointed this conversation at a directory when they opened it. */
    z.object({ kind: z.literal('somewhere-named'), path: z.string() }),
    /**
     * An agent opened this as a sub-task, and it belongs inside the work it was opened for.
     *
     * Beats a directory somebody named, which is why these cannot both be said: `subtask/` in
     * somebody's own checkout is an untracked directory in every `git status` they run.
     */
    z.object({ kind: z.literal('under'), conversationId: rowId }),
  ])
  .openapi('WhereToWork')

/** One question waiting for an answer on this machine. */
const Asking = named('SomethingToAnswer', {
  conversationId: rowId,
  agentKind: z.enum(AGENT_KIND_NAMES),
  /**
   * What the agent calls this conversation, when it has said so.
   *
   * Absent on a first turn, and handed back on every later one — it is how the agent is asked to
   * remember, and how a turn nobody saw the end of can be read back afterwards.
   */
  agentSession: z.string().nullable(),
  /**
   * Which line of the transcript this turn begins after.
   *
   * Not "which question this answers": a conversation somebody handed over runs turns nobody
   * asked for, and the line before those is the ending of the turn before them.
   */
  afterSeq: z.number().int(),
  /**
   * What this piece of work is for, when somebody handed the conversation over.
   *
   * Null when nobody has, and then `asked` is the whole of the turn. Sent on every turn rather
   * than once: the agent's memory of the last one may not have survived, and a turn that forgot
   * everything still has to know what it is doing.
   */
  goal: z.string().nullable(),
  /**
   * Which of the three places this turn works in. The machine turns it into a path.
   *
   * Nothing here has ever seen that disk, which is the point: a path that turns out to be wrong
   * is something the machine says on the turn it tries to use it, and a sandbox answers the same
   * three cases with a root of its own.
   */
  where: WhereToWork,
  /**
   * Whether anything has been run in this conversation before this turn.
   *
   * How a machine tells a folder it is making for the first time from one it is making again
   * because somebody deleted what was there. Only the second is worth a line in the transcript.
   */
  hasRunBefore: z.boolean(),
  asked: EVERYTHING_SAID,
  /** Which model to run, when the last person to speak chose one. */
  model: z.string().nullable(),
  /** How hard to think, when the last person to speak chose. */
  effort: z.string().nullable(),
})

/** Which turn a stop is about. Both halves, so a stop cannot be applied to a later turn. */
const Stopping = named('StopWanted', { conversationId: rowId, afterSeq: z.number().int() })

const CheckedIn = named('CheckedIn', {
  /**
   * How long to wait before asking again.
   *
   * Zero because this deployment holds the question instead: the answer to "is there anything for
   * me" does not come back until there is, or until the hold is up. A machine that also slept
   * would double the gap, and be counted as gone halfway through it.
   */
  pollSeconds: z.number().int().nonnegative(),
  /** Which commands to look for. Told every time, so the list can change without a release. */
  lookFor: z.array(z.string()).readonly(),
  /**
   * Absent when there is nothing to do. One at a time, still — not because a machine runs one
   * thing, but because it asks again the moment it has started this one, and one turn per answer
   * keeps "what am I owed" a question with a single answer.
   */
  asking: Asking.optional(),
  /**
   * Every turn somebody has asked this machine to stop working on.
   *
   * A list because a machine runs several: told about one of them, it would have no way to say
   * which, and a stop asked about the other would wait for the first to end before it was heard.
   *
   * The turn and not just the conversation: a stop read a moment before the turn it was about
   * ended would otherwise stop whatever that machine picked up next, and leave that one claimed
   * with nobody running it.
   *
   * Told rather than pushed, because a machine is reached by nothing but its own asking. It keeps
   * being told until the agent says it stopped, which is what makes a stop that arrived while
   * nothing was listening arrive on the next report instead of being lost.
   */
  stopping: z.array(Stopping).readonly(),
})

const Agent = named('MachineAgent', {
  kind: z.enum(AGENT_KIND_NAMES),
  /** What its owner calls it. Null means nobody has, and its kind's own name is what shows. */
  name: z.string().nullable(),
  /** The current limit this owner chose, or the server's default when they never chose one. */
  atOnce: z.number().int().min(1).max(AT_ONCE_AT_MOST),
  avatarUrl: z.string(),
  version: z.string(),
  /** Empty when this agent does not let you choose, and when nobody has asked it yet. */
  models: Models,
})

const Machine = named('Machine', {
  id: rowId,
  name: z.string(),
  /**
   * Whose it is, and whether that is you.
   *
   * A Space with two people in it has two people's laptops in it, and what an agent does on one
   * of them happens in that person's files. Only its owner can disconnect it, and a page that did
   * not say which was which would be offering everybody a button that only works on one.
   */
  ownerName: z.string(),
  yours: z.boolean(),
  /**
   * Which build of the CLI it is running.
   *
   * Absent when it has never said, which is a build older than the field itself. Shown as such
   * rather than filled in — a version this deployment guessed would be read as one it was told.
   */
  version: z.string().optional(),
  /**
   * The directory it was connected in, when it is a build that says so.
   *
   * What a screen offers as "my project" when somebody opens a conversation on this machine. Not
   * where anything runs: where a conversation works is that conversation's, and this is only the
   * one path a person can pick without typing one.
   */
  connectedIn: z.string().optional(),
  presence: Presence,
  agents: z.array(Agent).readonly(),
})

const Machines = list('machines', Machine)

/** Who a machine is being handed to. */
const HandMachineTo = named('HandMachineTo', { ownerUserId: rowId })

/**
 * What an owner decides about one agent. A patch: what is left out is left alone.
 *
 * Both are theirs rather than a Space's, which is why they arrive at the same door.
 */
const AgentSettings = named('AgentSettings', {
  /** Null puts it back to what its kind is called, which is the only way to take a name off. */
  name: z.string().trim().min(1).max(48).nullable().optional(),
  /** How many pieces of work it may run at the same time. Their laptop, their number. */
  atOnce: z.number().int().min(1).max(AT_ONCE_AT_MOST).optional(),
})

export function machineApi(deps: MachineApi) {
  return [
    polling(deps),
    leaving(deps),
    listing(deps),
    decidingAboutAgent(deps),
    detaching(deps),
    handingOver(deps),
  ]
}

/**
 * A question this machine has just taken, as it is told about it.
 *
 * `asked` is parsed on the way out rather than trusted: it went in as JSON, and a row written by
 * an older build is exactly the case where a shape can be wrong. A row that will not parse is one
 * this machine cannot act on, and pretending otherwise sends it a turn it cannot take.
 */
function asAsking(taken: Taken) {
  return {
    conversationId: taken.conversationId,
    agentKind: taken.agentKind as AgentKind,
    agentSession: taken.agentSession,
    afterSeq: taken.afterSeq,
    goal: taken.goal,
    where: whereItWorks(taken),
    hasRunBefore: taken.hasRunBefore,
    asked: EVERYTHING_SAID.parse(taken.asked),
    model: taken.model,
    effort: taken.effort,
  }
}

/**
 * Which of the three places a turn works in, decided here because this is where both facts are.
 *
 * A sub-task first: it belongs inside the work it was opened for, and that beats a directory
 * somebody named for the same conversation. Nothing can set both today — a hand-off opens the
 * conversation itself and never points it anywhere — but the order is written down rather than
 * left to be true by accident, because the day something does set both, the answer is already
 * decided and it is decided once.
 */
function whereItWorks(taken: Taken): z.infer<typeof WhereToWork> {
  if (taken.subtaskOf !== null) return { kind: 'under', conversationId: taken.subtaskOf }
  if (taken.worksIn !== null) return { kind: 'somewhere-named', path: taken.worksIn }

  return { kind: 'its-own' }
}

/**
 * Handing one to somebody else here.
 *
 * Whoever approved it still approved it — that is history and does not move. What moves is which
 * Spaces it can be reached from and who may disconnect it.
 *
 * `PATCH` and not a `POST` to some transfer: nothing is created. One field of a thing that
 * already exists says somebody else's name now.
 */
function handingOver({ db }: MachineApi) {
  return anOwner(db).patch('/spaces/{slug}/machines/{id}', {
    summary: 'Hand a machine to somebody else here',
    params: { id: rowId },
    body: HandMachineTo,
    answers: {
      204: 'It is theirs',
      404: refuses(CANNOT_HAND_OVER, 'No such Space, no such machine, or nobody here by that name'),
    },

    run: async (c) => {
      const handed = await handMachineTo(db, {
        spaceId: c.get('space').id,
        machineId: c.req.valid('param').id,
        userId: c.req.valid('json').ownerUserId,
      })
      if (handed.kind === 'not-a-member') return refused(c, CANNOT_HAND_OVER)

      return nothing(c, 204)
    },
  })
}

/**
 * What this machine is owed right now, waiting for it if there is nothing yet.
 *
 * The wait is what makes the whole journey feel like one: without it, everything anybody says
 * sits until the machine next asks, and that gap is the delay a person feels between pressing
 * send and the agent starting.
 */
async function anythingFor(deps: MachineApi, machineId: string) {
  const owed = await deps.waiting.somethingFor(machineId, async () =>
    whatIsOwed(deps.db, machineId),
  )

  return {
    // Nothing, because the waiting happened here. A machine that slept as well would report half
    // as often as this deployment thinks it does, and be counted gone halfway through its own
    // hold.
    pollSeconds: 0,
    lookFor: AGENT_COMMANDS,
    // Said even when the hold came back with nothing, because "nothing to stop" is an answer a
    // machine acts on: it is how one learns that a turn it was told to stop is over.
    stopping: [],
    ...owed,
  }
}

/**
 * Anything this machine has to be told, or nothing.
 *
 * Both, every time. A stop used to be the whole answer, which it could be while a machine ran one
 * thing: the turn being stopped was the only turn. Now it is one of several, and answering with
 * only the stop would leave everything else this machine is owed waiting on it — including the
 * question that was going to fill the slot the stop is about to free.
 *
 * Nothing here checks whether an agent is already full before asking for a question —
 * {@link takeOne} will not hand one to an agent that is, and that belongs there rather than at
 * this door.
 */
async function whatIsOwed(db: Database, machineId: string) {
  const stopping = await stopsWantedOn(db, machineId)
  const taken = await takeOne(db, machineId)
  if (stopping.length === 0 && taken === undefined) return undefined

  if (taken === undefined) return { stopping }
  return { stopping, asking: asAsking(taken) }
}

/** The one thing a machine ever does unprompted, and so the only way anything reaches it. */
function polling(deps: MachineApi) {
  return aMachine(deps.db).post('/machines/current/poll', {
    summary: 'Report what this machine has, and ask whether there is anything for it',
    body: Report,
    answers: {
      200: sends(CheckedIn, 'What to look for, and anything waiting'),
      401: refuses(NOT_OURS, 'Not a live machine credential, or not a machine any more'),
    },

    run: async (c) => {
      const machineId = c.get('machineId')
      const reported: z.infer<typeof Report> = c.req.valid('json')
      // Removed between the credential being read and this transaction opening: nothing to check
      // in, nothing to take, and the same answer a stranger gets. Waiting for the next request to
      // notice would be one more report, one more turn taken, from a machine somebody took out.
      const still = await checkIn(deps.db, machineId, {
        version: reported.version,
        connectedIn: reported.connectedIn,
        found: agentsFound(reported.found),
      })
      if (!still) return refused(c, NOT_OURS)

      if (reported.restarted === true) await forgetStranded(deps.db, machineId)

      return c.json(await anythingFor(deps, machineId), 200)
    },
  })
}

/** Going away on purpose, so nobody has to wait out the silence to find out. */
function leaving({ db }: MachineApi) {
  return aMachine(db).delete('/machines/current/session', {
    summary: 'Say this machine is stopping on purpose',
    answers: { 204: 'Gone, without waiting out the silence' },

    run: async (c) => {
      await sayGoodbye(db, c.get('machineId'))

      return nothing(c, 204)
    },
  })
}

/** Every machine this Space can reach — its members' — here or not. */
function listing({ db }: MachineApi) {
  return aMember(db).get('/spaces/{slug}/machines', {
    summary: 'The machines this Space can reach',
    answers: { 200: sends(Machines, 'Every member\u2019s machines, here or not') },

    run: async (c) => {
      // `asOf` comes back with them, from the same clock that wrote `last_seen_at`. A `new Date()`
      // here would be this process's clock deciding a fact the database's clock recorded.
      const seen = await machinesIn(db, c.get('space').id)
      const machines = seen.machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        version: machine.version,
        connectedIn: machine.connectedIn ?? undefined,
        ownerName: machine.ownerName,
        yours: machine.ownerUserId === c.get('userId'),
        presence: onTheWire(machine.whereabouts, seen.asOf),
        agents: machine.agents.map((agent) => asOffered(machine.id, agent)),
      }))

      return c.json({ machines }, 200)
    },
  })
}

/**
 * Deciding about one agent on one of your machines: what it is called, and how much it takes on.
 *
 * Both follow the owner, not a Space: the same laptop appears in every Space its owner is in, and
 * an agent called something different in each — or allowed more in one room than another — would
 * be a different agent to each. Under `/me` for that reason: it is not a Space's to change, and
 * no Space is named in the path.
 */
function decidingAboutAgent({ db }: MachineApi) {
  return aPerson(db).patch('/me/machines/{id}/agents/{kind}', {
    summary: 'Decide what one agent on one of your machines is called and how much it takes on',
    params: { id: rowId, kind: z.enum(AGENT_KIND_NAMES) },
    body: AgentSettings,
    answers: {
      204: 'Decided',
      404: refuses(UNAVAILABLE, 'You have no installed agent with that identity'),
    },

    run: async (c) => {
      const { id, kind } = c.req.valid('param')
      const done = await setAgentSettings(db, {
        machine: id,
        owner: c.get('userId'),
        kind,
        ...c.req.valid('json'),
      })

      return done ? nothing(c, 204) : refused(c, UNAVAILABLE)
    },
  })
}

/**
 * Disconnecting one, which is also what stops its credential working.
 *
 * Yours, not a Space's. A machine belongs to whoever connected it, so nobody else can take it
 * away — and there is nothing to take it out *of*: where it can be reached from follows from
 * where its owner is a member.
 */
function detaching({ db }: MachineApi) {
  return aPerson(db).delete('/me/machines/{id}', {
    summary: 'Disconnect one of your machines',
    params: { id: rowId },
    instead: UNAVAILABLE,
    answers: {
      204: 'Disconnected, and its credential stops working',
      404: refuses(UNAVAILABLE, 'You have no machine with that id'),
    },

    run: async (c) => {
      const removed = await removeMachine(db, {
        machine: c.req.valid('param').id,
        owner: c.get('userId'),
      })

      // Somebody else's id disconnects nothing, and says what a machine you do not have says.
      if (!removed) return refused(c, UNAVAILABLE)

      return nothing(c, 204)
    },
  })
}

/**
 * An agent as a page reads it.
 *
 * The stored list is parsed on the way out rather than trusted: it went in as JSON, and a row
 * written by another build is exactly the case where a shape can be wrong. One that will not parse
 * comes back as no models at all — a page with no control is a page somebody can still use, and a
 * Space screen that will not load because of a model list would not be.
 */
function asOffered(machineId: string, agent: Installed): z.infer<typeof Agent> {
  const read = Models.safeParse(agent.models)

  return {
    kind: agent.kind,
    name: agent.name,
    atOnce: agent.atOnce,
    // The machine is part of the face: two Codexes in one Space are two agents, and one drawing
    // shared between them would make the page unable to say which of them said something.
    avatarUrl: avatarPath({ kind: 'agent', machineId, agentKind: agent.kind }),
    version: agent.version,
    models: read.success ? read.data : [],
  }
}

/** A `Date` is not a wire value. Converting here keeps the owner's shape free of transport. */
