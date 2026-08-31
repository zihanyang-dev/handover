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

import { z } from '@hono/zod-openapi'

/**
 * Which model, and how hard to think, for one thing a person said.
 *
 * Per message rather than per conversation because that is how a person actually works — the
 * cheap question and the hard one arrive in the same conversation. Absent means the agent's own
 * default; we never guess a value on its behalf.
 */
/**
 * How long one thing said may be: a document's worth, the same ceiling an output has.
 *
 * Not a size anybody should reach. It is here because nothing else stopped one — the pieces a
 * machine sends are bounded on the machine, and a bound that only one end keeps is a bound that
 * holds until somebody runs an older build, or writes a second client, or means harm.
 */
const SAID_AT_MOST = 65_536

/**
 * How long a glimpse of a tool call may be.
 *
 * These are excerpts by design and the machine already cuts them to four hundred characters. This
 * is the ceiling that says so out loud, rather than trusting whatever is at the other end to keep
 * doing it: what a tool was given can be an entire file, and the transcript is not where files go.
 */
const GLIMPSED_AT_MOST = 2_000

export const Asked = z
  .object({
    text: z.string().min(1).max(SAID_AT_MOST),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .openapi('Asked')

/** Something the agent said. Its reasoning is not here — see `THINKING_IS_NOT_KEPT`. */
const Answered = z.object({ text: z.string().max(SAID_AT_MOST) }).openapi('Answered')

/**
 * Something the agent did, already in our words.
 *
 * `name` is the tool's own name, never translated — the set of tools is open (an MCP server adds
 * however many it likes), so a table mapping names to our vocabulary would be wrong the day it is
 * written. `verb` is a courtesy the adapter extends to tools it recognises, and a page that gets
 * none still has `name` to show.
 */
const Did = z
  .object({
    /** Provider-local identity used only to reconcile a live tool row with this final record. */
    callId: z.string().max(200).optional(),
    name: z.string().max(GLIMPSED_AT_MOST),
    verb: z.string().max(GLIMPSED_AT_MOST),
    arg: z.string().max(GLIMPSED_AT_MOST),
    /**
     * How it went, when the tool says.
     *
     * Absent is a real answer: not every tool reports a verdict, and putting a tick beside one that
     * never said anything would be this side inventing it.
     */
    ok: z.boolean().optional(),
    excerpt: z.string().max(GLIMPSED_AT_MOST),
    /** The provider could not expose the beginning of this output. */
    truncated: z.boolean().optional(),
  })
  .openapi('Did')

/**
 * Everything that is neither speech nor a tool.
 *
 * `activityType` has no fixed set and no check constraint. A reader that meets one it does not
 * know shows the conversation without it, which is why a new kind of activity is a value and not
 * a migration.
 */
const Happened = z.looseObject({ activityType: z.string() }).openapi('Happened')

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
  /**
   * What it intends to do, as it stands right now.
   *
   * Written again in full every time it changes, because that is how both agents report it — a
   * plan is never a patch. Every version stays: "I meant to do this, then I changed my mind" is
   * the most worth keeping sentence in a piece of work, and a transcript holding only the last
   * one says it was always going to go that way.
   */
  planned: 'planned',
} as const

/** The activities that close a turn. A conversation is busy until one of these is its last word. */
const ENDINGS: readonly string[] = [
  ACTIVITY.done,
  ACTIVITY.cancelled,
  ACTIVITY.failed,
  ACTIVITY.unknown,
]

/**
 * The endings that are trouble, as opposed to a turn that simply finished.
 *
 * `cancelled` is not: somebody asked for it, and a conversation somebody handed over carries on
 * from an interruption the same way it carries on from anything else.
 *
 * Beside {@link ENDINGS} because it is the same kind of fact about the same words. Kept where the
 * words are, so that adding one is one decision in one place rather than a value here and a rule
 * somewhere that reads rows.
 */
const TROUBLE: readonly string[] = [ACTIVITY.failed, ACTIVITY.unknown]

/**
 * One step of a plan, and how far it has got.
 *
 * Three states and no fourth, because that is what both agents have: Claude Code's `TodoWrite`
 * says `pending | in_progress | completed`, and Codex's `turn/planUpdated` says
 * `pending | inProgress | completed`. The same three, spelled differently — so the spelling is
 * settled here once and the adapters translate into it, rather than a page learning both.
 */
export const STEP = { waiting: 'waiting', doing: 'doing', done: 'done' } as const

/** How much of a plan is kept: enough to read, not enough to be a document. */
const A_STEP_AT_MOST = 500
const STEPS_AT_MOST = 100

const PlanStep = z
  .object({
    text: z.string().min(1).max(A_STEP_AT_MOST),
    state: z.enum(STEP),
  })
  .openapi('PlanStep')

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

/**
 * The three a machine may write.
 *
 * Not the fourth. A person's line carries a person's name, and that name comes from the session
 * that sent it — so a route which accepted `role: 'user'` from a machine would let an agent write
 * a line under somebody's name. While no line had a name this was invisible and harmless; the
 * moment one does, it is forgery, and a name that can be forged is worse than no name at all.
 *
 * `prd.md` 06 ⑤.
 */
export const Reported = z.discriminatedUnion('role', [FROM.agent, FROM.tool, FROM.nobody])

export type Reported = z.infer<typeof Reported>

/** Where a line sits in its conversation, and when it landed. Added when it is read back. */
const PLACE = { seq: z.number().int(), at: z.iso.datetime() }

/**
 * One line as a reader gets it: the same four, each with its place.
 *
 * Built from the four above rather than written out again, because a second list of what a `tool`
 * line holds is a second list that can be wrong — and the page reading it would believe it.
 */
/**
 * Who said it, on the only kind of line a person says.
 *
 * A name and not an id: a page shows people, and it would otherwise hold a table of them to
 * translate every line. Null on lines written before a line could say who wrote it — `prd.md` 06
 * ⑥ is that those stay nameless rather than being guessed at.
 *
 * Absent from the other three rather than null on them: nobody said an agent's answer, a tool
 * call or an activity, and a field that is always null is a question that should not be asked.
 */
const SAID = { said: z.string().nullable() }

export const Spoken = z.discriminatedUnion('role', [
  FROM.person.extend(PLACE).extend(SAID),
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

/** Whether this is the message that says how a turn went. */
export function ends(message: Message): boolean {
  return message.role === 'activity' && ENDINGS.includes(message.content.activityType)
}

/** Whether that ending was trouble, rather than a turn that simply finished. */
export function wentWrong(message: Message): boolean {
  return message.role === 'activity' && TROUBLE.includes(message.content.activityType)
}

/**
 * One question written the same way, whatever order its fields arrived in and whichever of the
 * optional ones were left out.
 */
function written(asked: Asked): string {
  return JSON.stringify(
    Object.entries(asked)
      .filter(([, value]) => value !== undefined)
      .sort(([one], [other]) => one.localeCompare(other)),
  )
}

/**
 * Whether something already stored is the same question being asked again.
 *
 * Through the schema rather than field by field. Written out, a question that grew a fourth thing
 * a person can choose would still match on the three somebody had listed here, and a second
 * attempt at a *different* question would be handed the first one's conversation — silently, with
 * nothing anywhere going red.
 */
export function sameQuestion(stored: unknown, asked: Asked): boolean {
  const read = Asked.safeParse(stored)
  // Both sides through the schema, not one. Comparing a parsed value against a raw one makes
  // anything the schema would have dropped count as a difference, and the same question asked
  // twice would read as two.
  const again = Asked.safeParse(asked)

  return read.success && again.success && written(read.data) === written(again.data)
}

/** One version of a plan, as it was written down. */
export const Plan = z.array(PlanStep).max(STEPS_AT_MOST).readonly()

export type Plan = z.infer<typeof Plan>

/** Whether this line is a plan being written down. */
function isPlan(message: Message): boolean {
  return message.role === 'activity' && message.content.activityType === ACTIVITY.planned
}

/**
 * The plan as it stands, out of everything said.
 *
 * Derived and never stored, for the reason `machine/presence.ts` gives about being here: a second
 * place to say something is a second place to be wrong. Every version is in the transcript
 * already, in order, and the one that counts is the last — so that is what this is.
 *
 * Read from a line rather than trusted: a plan comes from an agent through an adapter, and a
 * misshapen one is a page that shows nothing rather than a page that breaks.
 */
export function planIn(messages: readonly Message[]): Plan | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || !isPlan(message)) continue

    // Narrowed by `isPlan` above, and read defensively anyway: the content of an activity is a
    // loose object by design, so what is in it is whatever an adapter put there.
    const written = message.content as Record<string, unknown>
    const read = Plan.safeParse(written['steps'])
    return read.success ? read.data : undefined
  }

  return undefined
}
