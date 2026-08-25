/**
 * What a conversation is made of.
 *
 * One flat list, discriminated by who a message is from. Not our invention: AG-UI stores a
 * conversation as `Message[]` keyed on role, Vercel's reference chat app stores one row per
 * message with a role column and its body as JSON, and OpenAI's Responses API stores a
 * conversation as items. Turn boundaries are messages here rather than a second table, because
 * every one of those keeps a single ordered list and nothing else.
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
export const Answered = z.object({ text: z.string() })

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
export const Happened = z.looseObject({ activityType: z.string() })

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
} as const

/** The activities that close a turn. A conversation is busy until one of these is its last word. */
export const ENDINGS: readonly string[] = [
  ACTIVITY.done,
  ACTIVITY.cancelled,
  ACTIVITY.failed,
  ACTIVITY.unknown,
]

export const Message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: Asked }),
  z.object({ role: z.literal('assistant'), content: Answered }),
  z.object({ role: z.literal('tool'), content: Did }),
  z.object({ role: z.literal('activity'), content: Happened }),
])

export type Message = z.infer<typeof Message>

/**
 * Who a message can be from, derived from the messages themselves.
 *
 * Written down once. A second list would be a second thing to remember when a fifth kind of
 * writer appears — and the one that gets forgotten is always the one furthest from the change.
 */
export const ROLES = Message.options.map((one) => one.shape.role.value)

export type Role = Message['role']
export type Asked = z.infer<typeof Asked>
