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
import { Asked, Reported, Spoken, unreadable } from '../conversation/transcript.ts'
import type { Database } from '../db/connection.ts'
import {
  askToStop,
  conversationWith,
  conversationsIn,
  machineSays,
  noteAgentSession,
  openConversation,
  sayTo,
  type Reading,
  type Standing,
} from '../db/conversation.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import { onTheWire, Presence } from '../machine/whereabouts.ts'
import { type Failure, UNAVAILABLE, refused } from './failure.ts'
import { aMachine, aMember, list, named, nothing, refuses, rowId, sends } from './route.ts'

export type ConversationApi = { readonly db: Database }

/** Its machine is here, but the agent is not on it any more. Nothing to wait for. */
const NO_AGENT: Failure<409> = {
  reason: 'agent-not-on-machine',
  recovery: 'choose-another-agent',
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

const TaskState = z.enum(['working', 'wait', 'sleep', 'done'])

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
const Output = named('Output', {
  title: z.string(),
  body: z.string(),
  writtenAt: z.iso.datetime(),
})

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
  machineName: z.string(),
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
  underway: Underway.optional(),
})

/**
 * A message and the name it goes by.
 *
 * The name is the caller's, not ours: only they know that the message they are sending now is the
 * one they already sent and never heard back about.
 */
const SayThis = named('SayThis', { ...CALLED, asked: Asked })

const StopThis = named('StopThis', CALLED)

const Conversations = list('conversations', Conversation)

const OpenConversation = named('OpenConversation', {
  machineId: rowId,
  agentKind: z.enum(AGENT_KIND_NAMES),
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
      const conversations = await conversationsIn(db, c.get('space').id)

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
       * to. Left out, they get all of it — which is what somebody opening a conversation for the
       * first time wants, and what asking again every second is not.
       */
      after: z.coerce.number().int().min(0).optional(),
    },
    answers: { 200: sends(Transcript, 'In order, oldest first'), 404: NOT_THERE },

    run: async (c) => {
      const transcript = await conversationWith(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        after: c.req.valid('query').after,
      })

      return transcript === undefined
        ? refused(c, UNAVAILABLE)
        : c.json(asTranscript(transcript), 200)
    },
  })
}

/** Starting one, which pins it to an agent on a machine for as long as it exists. */
function opening({ db }: ConversationApi) {
  return aMember(db).post('/spaces/{slug}/conversations', {
    summary: 'Start a conversation with one agent on one machine',
    body: OpenConversation,
    answers: {
      201: sends(OpenedConversation, 'Open, and pinned to that agent'),
      404: refuses(UNAVAILABLE, 'No such Space, or no such machine in it'),
      409: refuses(NO_AGENT, 'That machine does not have that agent'),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const opened = await openConversation(db, {
        spaceId: c.get('space').id,
        machineId: asked.machineId,
        agentKind: asked.agentKind,
      })

      if (opened.kind === 'no-machine') return refused(c, UNAVAILABLE)
      if (opened.kind === 'no-agent') return refused(c, NO_AGENT)

      return c.json({ id: opened.conversationId }, 201)
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
    answers: { 204: 'Said, or said already — either way it is in there once', 404: NOT_THERE },

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

      return nothing(c, 204)
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
    answers: { 204: 'Kept, unless it already had one' },

    run: async (c) => {
      await noteAgentSession(db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        session: c.req.valid('json').session,
      })

      return nothing(c, 204)
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

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
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
    outputs: underway.outputs.map((one) => ({ ...one, writtenAt: one.writtenAt.toISOString() })),
    under: underway.under,
  }
}

function asStanding(standing: Standing) {
  return { ...standing, startedAt: standing.startedAt.toISOString() }
}
