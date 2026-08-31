/**
 * Conversations: opening one, saying something into it, reading it back, and what the machine
 * running it writes.
 *
 * Two holders, and the same split as machines. A person opens, says and reads through their
 * Space; a machine writes only into the conversation it was handed, and the path never names a
 * machine — its credential does, so a path that said so would be one a caller could write
 * somebody else's name into.
 */

import { z } from '@hono/zod-openapi'
import { Models } from '../conversation/offers.ts'
import {
  Asked,
  Message as Written,
  Plan,
  planIn,
  Reported,
  Spoken,
  unreadable,
} from '../conversation/transcript.ts'
import type { Database } from '../db/connection.ts'
import {
  askToStop,
  conversationWith,
  conversationsIn,
  beginConversation,
  machineSays,
  noteAgentSession,
  pinConversation,
  sayTo,
  unpinConversation,
  type Reading,
  type Standing,
} from '../db/conversation.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import { onTheWire, Presence } from '../machine/whereabouts.ts'
import { STATE } from '../task/state.ts'
import { type Failure, UNAVAILABLE, refused } from './failure.ts'
import { aMachine, aMember, list, named, nothing, refuses, rowId, sends } from './route.ts'

export type ConversationApi = { readonly db: Database }

/** Its machine is here, but the agent is not on it any more. Nothing to wait for. */
const NO_AGENT: Failure<409> = {
  reason: 'agent-not-on-machine',
  recovery: 'choose-another-agent',
  status: 409,
}

/**
 * Its machine is not here, so the first message was not written.
 *
 * Only ever the answer to starting one. A conversation is pinned to its machine for as long as it
 * exists, so this is the last moment anybody can choose a different one — which is what the
 * recovery says to do. Saying something into a conversation that already exists is never refused
 * for this: there is nothing left to choose, and the words wait for the machine it has.
 */
const MACHINE_AWAY: Failure<409> = {
  reason: 'machine-not-here',
  recovery: 'choose-another-machine',
  status: 409,
}

/** A retry key belongs to its first intention; a different one needs a fresh key. */
const ID_TAKEN: Failure<409> = {
  reason: 'conversation-id-taken',
  recovery: 'start-over',
  status: 409,
}

/** It already stopped, or never started. Either way there is nothing here to interrupt. */
const NOTHING_RUNNING: Failure<409> = {
  reason: 'nothing-to-stop',
  recovery: 'start-over',
  status: 409,
}

/** No such Space, or no such conversation in it — one answer, so a URL tells nobody which. */
const NOT_THERE = refuses(UNAVAILABLE, 'No such Space, or no such conversation in it')

/** What the caller calls this request, so a lost answer is safe to retry. */
const CALLED = { key: z.string().min(1).max(200) }

const Working = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('working') }),
    z.object({ state: z.literal('unknown') }),
  ])
  .openapi('Working')

const Conversation = named('Conversation', {
  id: z.uuid(),
  agentKind: z.string(),
  machineId: z.uuid(),
  machineName: z.string(),
  startedAt: z.iso.datetime(),
  /** What was first asked. A conversation nobody has spoken into yet has nothing to show. */
  opening: z.string().nullable(),
  /** Who asked it. Null before anybody has, and on conversations older than names. */
  startedBy: z.string().nullable(),
  /**
   * Whether that was this person. Answered here because {@link startedBy} is a display name and
   * two people in one Space may share one, so the browser cannot decide it by comparing.
   */
  startedByYou: z.boolean(),
  /** This person's own mark on it. Nobody else's list changes when it is set. */
  pinned: z.boolean(),
  working: Working,
})

/**
 * One thing said, as a page reads it.
 *
 * The shape of a line is part of the contract, per role — otherwise every page that renders one
 * has to write down what a tool call holds, and a hand-written copy of a contract is the thing
 * this repository refuses everywhere else.
 *
 * A line this build cannot read still comes back, as an activity that says so: refusing to open a
 * conversation because one line in it is unfamiliar would lose the whole of it over the least of
 * it. That door stays open on purpose — an activity type nobody has heard of is a value, not a
 * release.
 */
const Message = Spoken.openapi('Message')

/**
 * The four, from the module that owns them rather than written out again.
 *
 * Listed here, a fifth state would exist everywhere except on the wire — and the screen reading
 * this would refuse the answer as malformed rather than show it.
 */
const TaskState = z.enum(STATE)

/** A piece of work this one opened for another agent, and has not had back yet. */
const HandedOff = named('HandedOff', {
  conversationId: z.uuid(),
  goal: z.string(),
  state: TaskState,
  machineName: z.string(),
  agentKind: z.string(),
  /** Its machine. One that is not here is one this piece of work will wait on for ever. */
  presence: Presence,
})

/** Something it wrote on purpose. Not what it happened to touch on the way. */
const Output = named('Output', { title: z.string(), body: z.string() })

/** The piece of work that handed this one out. */
const Under = named('Under', { conversationId: z.uuid(), goal: z.string() })

/**
 * The piece of work underway in a conversation, when somebody handed it over.
 *
 * Absent means nobody has — which is what a page shows by showing nothing extra at all. Its
 * presence *is* the difference between a conversation you are sitting in and one you walked away
 * from, so a page never has to ask a second question to know which it is looking at.
 */
const Underway = named('Underway', {
  goal: z.string(),
  /** The current responsible person, so a transfer control can distinguish change from no-op. */
  ownerUserId: rowId,
  state: TaskState,
  /** When it will wake by itself. Only ever set while it is asleep. */
  sleepUntil: z.iso.datetime().nullable(),
  /** Its own machine, said the same way its children's are. */
  presence: Presence,
  /** Still open, which is why the one that handed them out is not being given turns. */
  handedOff: z.array(HandedOff).readonly(),
  /** Newest first. */
  outputs: z.array(Output).readonly(),
  /** Null when a person handed this one over rather than an agent. */
  under: Under.nullable(),
})

const Transcript = named('Transcript', {
  id: z.uuid(),
  agentKind: z.string(),
  /** Which machine it runs on. The name is the machines list's to say — see `db/conversation.ts`. */
  machineId: rowId,
  working: Working,
  /**
   * What this agent lets a person choose, one question at a time.
   *
   * Empty means there is nothing to choose and the page shows no control — which covers both an
   * agent that does not offer a choice and one nobody has asked yet. Saying nothing is always
   * allowed, and means the agent's own default.
   */
  offers: Models,
  messages: z.array(Message).readonly(),
  /**
   * Whether anything was said before the first line here.
   *
   * About this page and not the conversation. False is "you are looking at the beginning", and
   * it is the only thing that stops a page asking for what came before for ever.
   */
  earlier: z.boolean(),
  /**
   * What the agent means to do, as it stands.
   *
   * Read out of the lines rather than stored beside them, so there is one place a plan lives and
   * it is the same place everything else that happened lives. Absent when no plan was ever
   * written, which is an agent that does not plan and not an agent in trouble.
   *
   * Sent even when the page holding it has scrolled past the line it came from — which is the
   * whole reason it is here and not left for the browser to find.
   */
  plan: Plan.optional(),
  underway: Underway.optional(),
})

/**
 * A message and the name it goes by.
 *
 * The name is the caller's, not ours: only they know that the message they are sending now is the
 * one they already sent and never heard back about.
 */
const SayThis = named('SayThis', {
  ...CALLED,
  asked: Asked,
  /** The last line the sender already has, so the answer is only the authoritative tail. */
  after: z.number().int().nonnegative().optional(),
})

const StopThis = named('StopThis', CALLED)

const Conversations = list('conversations', Conversation)

const OpenConversation = named('OpenConversation', {
  /**
   * Made by the caller, so a lost answer can be asked for again without opening a second one.
   *
   * The id is the key because the intention spans two rows — the conversation and its first
   * message — and only the caller knows that the request it is making now is the one it already
   * made and never heard back about.
   */
  id: rowId,
  machineId: rowId,
  agentKind: z.enum(AGENT_KIND_NAMES),
  asked: Asked,
})

const OpenedConversation = named('OpenedConversation', { id: z.uuid() })

const MachineMessage = named('MachineMessage', { ...CALLED, message: Reported })

const AgentSession = named('AgentSession', { session: z.string().min(1).max(200) })

export function conversationApi(deps: ConversationApi) {
  return [
    listing(deps),
    reading(deps),
    opening(deps),
    saying(deps),
    stopping(deps),
    pinning(deps),
    unpinning(deps),
    reporting(deps),
    naming(deps),
  ]
}

/** Everything in this Space, newest first. */
function listing({ db }: ConversationApi) {
  return aMember(db).get('/spaces/{slug}/conversations', {
    summary: 'The conversations in this Space',
    answers: {
      200: sends(Conversations, 'Newest first, each with whether it is being worked on'),
    },

    run: async (c) => {
      const conversations = await conversationsIn(db, c.get('space').id, c.get('userId'))

      return c.json({ conversations: conversations.map(asStanding) }, 200)
    },
  })
}

/** One conversation and everything said in it. Reading changes nothing, so nothing is refused. */
function reading({ db }: ConversationApi) {
  return aMember(db).get('/spaces/{slug}/conversations/{id}', {
    summary: 'Everything said in one conversation',
    params: { id: rowId },
    query: {
      /**
       * The last line the reader already has.
       *
       * Everything past it is everything they are missing, because a transcript is only appended
       * to — and all of it, however much arrived, because a catch-up handed back a page at a time
       * would be a page that goes on being behind.
       */
      after: z.coerce.number().int().min(0).optional(),
      /**
       * The earliest line the reader already has, when they are asking for what came before it.
       *
       * The other direction, and the only one that is a page: a year of conversation scrolled
       * through from the end. With both left out the read is the end of the transcript, which is
       * where somebody opening one is looking — and what used to be the whole of it, however long.
       */
      before: z.coerce.number().int().min(1).optional(),
    },
    answers: { 200: sends(Transcript, 'In order, oldest first'), 404: NOT_THERE },

    run: async (c) => {
      const transcript = await conversationWith(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        after: c.req.valid('query').after,
        before: c.req.valid('query').before,
      })

      return transcript === undefined
        ? refused(c, UNAVAILABLE)
        : c.json(asTranscript(transcript), 200)
    },
  })
}

/**
 * Starting one, which is the same action as saying its first thing.
 *
 * There is no way to make an empty conversation, because an empty conversation is not something
 * anybody wants: a person who opens the composer and walks away has left nothing behind, and a
 * list that showed the attempt would be a list of things nobody said. The machine is checked to
 * be here for the same reason — this is the last moment a different one can be chosen.
 */
function opening({ db }: ConversationApi) {
  return aMember(db).post('/spaces/{slug}/conversations', {
    summary: 'Start a conversation by saying its first message',
    body: OpenConversation,
    answers: {
      201: sends(OpenedConversation, 'Open, pinned to that agent, with the first message in it'),
      404: refuses(UNAVAILABLE, 'No such Space, or no such machine in it'),
      409: refuses(
        [NO_AGENT, MACHINE_AWAY, ID_TAKEN],
        'That machine or agent cannot take this first message',
      ),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const opened = await beginConversation(db, {
        conversationId: asked.id,
        spaceId: c.get('space').id,
        machineId: asked.machineId,
        agentKind: asked.agentKind,
        asked: asked.asked,
        // From the session, never from the body, for the reason `saying` says.
        saidBy: c.get('userId'),
      })

      if (opened.kind === 'no-machine') return refused(c, UNAVAILABLE)
      if (opened.kind === 'no-agent') return refused(c, NO_AGENT)
      if (opened.kind === 'machine-away') return refused(c, MACHINE_AWAY)
      if (opened.kind === 'id-taken') return refused(c, ID_TAKEN)

      return c.json({ id: opened.conversationId }, 201)
    },
  })
}

/**
 * Keeping one near the top, for the person who asked and nobody else.
 *
 * PUT and DELETE rather than a toggle, so the request says the end state it wants: a retry after
 * an answer nobody saw is the same pin, not a second one and not an unpin. The Space is part of
 * the write — being a member of this one does not make an id in the path belong to it.
 */
function pinning({ db }: ConversationApi) {
  return aMember(db).put('/spaces/{slug}/conversations/{id}/pin', {
    summary: 'Pin a conversation for yourself',
    params: { id: rowId },
    answers: { 204: 'Pinned, or pinned already', 404: NOT_THERE },

    run: async (c) => {
      const pinned = await pinConversation(db, {
        spaceId: c.get('space').id,
        conversationId: c.req.valid('param').id,
        userId: c.get('userId'),
      })

      return pinned ? nothing(c, 204) : refused(c, UNAVAILABLE)
    },
  })
}

/** Taking the mark off. Never there is already the end state asked for, including an id from
 * another Space — which is why this one has nothing to refuse. */
function unpinning({ db }: ConversationApi) {
  return aMember(db).delete('/spaces/{slug}/conversations/{id}/pin', {
    summary: 'Unpin a conversation for yourself',
    params: { id: rowId },
    answers: { 204: 'Unpinned, or unpinned already' },

    run: async (c) => {
      await unpinConversation(db, {
        spaceId: c.get('space').id,
        conversationId: c.req.valid('param').id,
        userId: c.get('userId'),
      })

      return nothing(c, 204)
    },
  })
}

/**
 * Saying something, which interrupts the agent if it is in the middle of something.
 *
 * Saying and stopping are one action for whoever is typing: you do not tell an agent to leave
 * `legacy/` alone and then wait for it to finish editing `legacy/`. Both facts are still written
 * down separately — that you asked it to stop, and what you said.
 */
function saying({ db }: ConversationApi) {
  return aMember(db).post('/spaces/{slug}/conversations/{id}/messages', {
    summary: 'Say something to the agent',
    params: { id: rowId },
    body: SayThis,
    answers: {
      200: sends(Transcript, 'The authoritative tail containing what just landed'),
      404: NOT_THERE,
      409: refuses(NO_AGENT, 'Its agent is not on that machine any more'),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const landed = await sayTo(
        db,
        {
          conversationId: c.req.valid('param').id,
          spaceId: c.get('space').id,
          key: asked.key,
          // From the session, never from the body: an endpoint that reads the author out of what
          // it was sent is an endpoint that lets the caller say who they are.
          saidBy: c.get('userId'),
        },
        asked.asked,
      )

      if (landed.kind === 'no-conversation') return refused(c, UNAVAILABLE)
      if (landed.kind === 'no-agent') return refused(c, NO_AGENT)

      const reading = await conversationWith(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        after: asked.after,
      })
      if (reading === undefined) {
        throw new Error('conversation disappeared after its message was written')
      }

      return c.json(asTranscript(reading), 200)
    },
  })
}

/** Asking it to stop, which is allowed only while there is something to stop. */
function stopping({ db }: ConversationApi) {
  return aMember(db).post('/spaces/{slug}/conversations/{id}/stop', {
    summary: 'Ask the agent to stop what it is doing',
    params: { id: rowId },
    body: StopThis,
    answers: {
      204: 'Asked, or asked already',
      404: NOT_THERE,
      409: refuses(NOTHING_RUNNING, 'Nothing is running in it'),
    },

    run: async (c) => {
      const asked = await askToStop(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: c.req.valid('json').key,
      })

      if (asked.kind === 'no-conversation') return refused(c, UNAVAILABLE)
      if (asked.kind === 'nothing-to-stop') return refused(c, NOTHING_RUNNING)

      return nothing(c, 204)
    },
  })
}

/** What the agent said or did. */
function reporting({ db }: ConversationApi) {
  return aMachine(db).post('/machines/current/conversations/{id}/messages', {
    summary: 'Add what the agent said or did',
    params: { id: rowId },
    body: MachineMessage,
    answers: {
      204: 'Written, or already written',
      404: refuses(UNAVAILABLE, 'That conversation was not given to this machine'),
    },

    run: async (c) => {
      const sent = c.req.valid('json')
      const written = await machineSays(db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        key: sent.key,
        message: sent.message,
      })

      return written.kind === 'no-conversation' ? refused(c, UNAVAILABLE) : nothing(c, 204)
    },
  })
}

/** What the agent calls a conversation, which is how a later turn asks it to remember. */
function naming({ db }: ConversationApi) {
  return aMachine(db).put('/machines/current/conversations/{id}/session', {
    summary: 'Record what the agent calls this conversation',
    params: { id: rowId },
    body: AgentSession,
    answers: {
      204: 'Kept, unless it already had one',
      404: refuses(UNAVAILABLE, 'That conversation was not given to this machine'),
    },

    run: async (c) => {
      const noted = await noteAgentSession(db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        session: c.req.valid('json').session,
      })

      return noted ? nothing(c, 204) : refused(c, UNAVAILABLE)
    },
  })
}

/**
 * A stored conversation as the wire carries it.
 *
 * Everything is parsed on the way out rather than trusted. It all went in as JSON, and a row
 * written by another build is exactly where a shape can be wrong — the difference between the two
 * failures is what each costs: a list of models that will not read is nothing to choose from, and
 * a page with no control still works; a line that will not read is one line, and the rest of the
 * conversation is still what happened.
 */
function asTranscript(reading: Reading) {
  const offers = Models.safeParse(reading.offers)
  // Out of the rows as they are, not the wire shapes below: a plan is read from what was
  // actually written down, and a line this route could not parse is not a line that changes it.
  const plan = planIn(reading.messages.flatMap((one) => Written.safeParse(one).data ?? []))

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
    ...(plan === undefined ? {} : { plan }),
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
}

/** The piece of work underway, flattened for the wire. Undefined when nobody handed one over. */
function asUnderway(underway: Reading['underway']) {
  if (underway === undefined) return undefined

  return {
    goal: underway.task.goal,
    ownerUserId: underway.task.ownerUserId,
    state: underway.task.state,
    sleepUntil: underway.task.sleepUntil?.toISOString() ?? null,
    presence: onTheWire(underway.whereabouts, underway.asOf),
    handedOff: underway.handedOff.map((one) => ({
      conversationId: one.conversationId,
      goal: one.goal,
      state: one.state,
      machineName: one.machineName,
      agentKind: one.agentKind,
      presence: onTheWire(one.whereabouts, underway.asOf),
    })),
    outputs: underway.outputs,
    under: underway.under,
  }
}

function asStanding(standing: Standing) {
  return { ...standing, startedAt: standing.startedAt.toISOString() }
}
