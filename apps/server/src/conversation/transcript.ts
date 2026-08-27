/**
 * What a conversation is made of.
 *
 * One flat list, discriminated by who a message is from. Not our invention: AG-UI stores a
 * conversation as `Message[]` keyed on role, Vercel's reference chat app stores one row per
 * message with a role column and its body as JSON, and OpenAI's Responses API stores a
 * conversation as items.
 *
 * How a turn *looked* is written here; who is running it is not. That is `turns`, and the split
 * is the point: this list is the record, open to whatever an agent has to say, and the ledger is
 * the truth, closed and decided by the database. Judgement never reads this file's shape — read
 * from here, "is it still answering" reports a question nobody has picked up yet as answered, and
 * two processes can run the same one.
 */

import { z } from 'zod'

/**
 * Which model, and how hard to think, for one thing a person said.
 *
 * Per message rather than per conversation because that is how a person actually works — the
 * cheap question and the hard one arrive in the same conversation. Absent means the agent's own
 * default; we never guess a value on its behalf.
 */
export const Asked = z.object({
  text: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
})

/** Something the agent said. Its reasoning is not here — see `THINKING_IS_NOT_KEPT`. */
const Answered = z.object({ text: z.string() })

/**
 * Something the agent did, already in our words.
 *
 * `name` is the tool's own name, never translated — the set of tools is open (an MCP server adds
 * however many it likes), so a table mapping names to our vocabulary would be wrong the day it is
 * written. `verb` is a courtesy the adapter extends to tools it recognises, and a page that gets
 * none still has `name` to show.
 */
const Did = z.object({
  name: z.string(),
  verb: z.string(),
  arg: z.string(),
  /**
   * How it went, when the tool says.
   *
   * Absent is a real answer: not every tool reports a verdict, and putting a tick beside one that
   * never said anything would be this side inventing it.
   */
  ok: z.boolean().optional(),
  excerpt: z.string(),
})

/**
 * Everything that is neither speech nor a tool.
 *
 * `activityType` has no fixed set and no check constraint. A reader that meets one it does not
 * know shows the conversation without it, which is why a new kind of activity is a value and not
 * a migration.
 */
const Happened = z.looseObject({ activityType: z.string() })

/**
 * The activities this slice writes.
 *
 * Not a closed set — the column has no check constraint, and a reader that meets an unfamiliar
 * one shows the conversation without it. These are only the ones something here depends on.
 */
export const ACTIVITY = {
  /** The agent finished this turn. */
  done: 'done',
  /** It stopped because somebody asked it to. Not a failure. */
  cancelled: 'cancelled',
  /** It could not do this turn, and saying the same thing again is safe. */
  failed: 'failed',
  /**
   * Nobody can say what happened on its side. Never guessed into either of the two above and
   * never replayed on its own: the agent may well have finished, and repeating the turn would
   * repeat whatever it already did.
   */
  unknown: 'unknown',
  /** A person asked it to stop. Written when they ask — that it stopped is a separate fact. */
  stopAsked: 'stop',
  /** It could not pick up the earlier session, so this turn began with no memory of the last. */
  forgot: 'forgot',
  /** Not something that happened: a line written in a shape this build cannot read. */
  unreadable: 'unreadable',

  /**
   * The seven a handed-over piece of work leaves behind.
   *
   * Every one of them is a **moment** — what happened, and when. What is true *now* is
   * `tasks.state`, and nothing decides anything by reading these. The two are written in the same
   * transaction and are not two copies of one fact: one says "at 03:02 it asked you", the other
   * says "it is still waiting". Without the first, nothing could tell somebody when it got stuck;
   * without the second, deciding would mean going back through the transcript.
   *
   * They are also the whole of what a reader is shown as "what has happened so far" — which is
   * why none of them needs the agent to write anything beyond the command it was already running.
   */
  /** A goal put in front of a person to approve. Nothing has begun until they do. */
  proposed: 'proposed',
  /** From here it moves without being spoken to. Carries the goal a person approved. */
  handedOver: 'handed-over',
  /** It opened a piece of work for somebody else. Carries which one. */
  handedOff: 'handed-off',
  /** Something it handed off came back. Carries what that one said. */
  handedBack: 'handed-back',
  /** It stopped to ask its owner something. What it asked is its own message, just before. */
  asked: 'asked',
  /** It is waiting out a moment. Carries which. */
  asleep: 'asleep',
  /** Over, and how: it finished, or it says it cannot. */
  finished: 'finished',
  /** A person took it back. Whatever it had handed off was taken back with it. */
  takenBack: 'taken-back',
} as const

/** The activities that close a turn. A conversation is busy until one of these is its last word. */
export const ENDINGS: readonly string[] = [
  ACTIVITY.done,
  ACTIVITY.cancelled,
  ACTIVITY.failed,
  ACTIVITY.unknown,
]

/** Who each line is from, and what a line from them holds. The four, written once. */
const FROM = {
  person: z.object({ role: z.literal('user'), content: Asked }),
  agent: z.object({ role: z.literal('assistant'), content: Answered }),
  tool: z.object({ role: z.literal('tool'), content: Did }),
  nobody: z.object({ role: z.literal('activity'), content: Happened }),
} as const

export const Message = z.discriminatedUnion('role', [
  FROM.person,
  FROM.agent,
  FROM.tool,
  FROM.nobody,
])

export type Message = z.infer<typeof Message>

/** Where a line sits in its conversation, and when it landed. Added when it is read back. */
const PLACE = { seq: z.number().int(), at: z.iso.datetime() }

/**
 * One line as a reader gets it: the same four, each with its place.
 *
 * Built from the four above rather than written out again, because a second list of what a `tool`
 * line holds is a second list that can be wrong — and the page reading it would believe it.
 */
export const Spoken = z.discriminatedUnion('role', [
  FROM.person.extend(PLACE),
  FROM.agent.extend(PLACE),
  FROM.tool.extend(PLACE),
  FROM.nobody.extend(PLACE),
])

export type Spoken = z.infer<typeof Spoken>

/**
 * What a line this build cannot read comes back as.
 *
 * Kept rather than dropped: a transcript is an account of what happened, and a gap in it is worse
 * than a line saying it cannot be read. It goes through the one door that is deliberately open —
 * an activity type nobody has heard of — so no reader needs a new branch to show it.
 */
export function unreadable(seq: number, at: Date): Spoken {
  return { seq, at: at.toISOString(), role: 'activity', content: { activityType: 'unreadable' } }
}

/**
 * Who a message can be from, derived from the messages themselves.
 *
 * Written down once. A second list would be a second thing to remember when a fifth kind of
 * writer appears — and the one that gets forgotten is always the one furthest from the change.
 */
export const ROLES = Message.options.map((one) => one.shape.role.value)

export type Asked = z.infer<typeof Asked>
