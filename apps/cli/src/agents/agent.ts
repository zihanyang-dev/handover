import type { components } from '../../generated/api.ts'

/**
 * What it takes to drive one agent.
 *
 * An adapter implements this and nothing else. Ordering, persistence, idempotency, retries and
 * the three outcomes belong to the caller — an adapter that reaches for any of them has taken
 * over a decision that is not its to make.
 *
 * Adding an agent is this file implemented once more plus a line in `known-agents.ts`. Nothing
 * in the database, the API, or the page has to know it happened.
 */

export type Agent = {
  /**
   * The command this drives, as it is found on the PATH.
   *
   * Said by the adapter because the adapter is what has to run it. Discovery reports by command
   * and the server hands out work by kind, so something has to pair them; the one place that
   * cannot get it wrong is the file that spawns the thing.
   */
  readonly command: string

  /**
   * What this agent lets a person choose, as it reports it right now.
   *
   * Empty means it does not let you choose, and the page then has no control to show. Agents
   * differ here and that is the honest answer: picking an agent is picking what it can do.
   */
  readonly offers: (where: string) => Promise<readonly Model[]>

  /**
   * Begin one turn, or pick up a conversation this agent still remembers.
   *
   * One turn per {@link Talk}: `sofar` is fixed when it is made, so a second turn asks for a new
   * one with whatever session the first turn reported.
   */
  readonly talk: (where: string, sofar: string | null) => Talk
}

/**
 * One thing this agent lets a person choose for a single question.
 *
 * The wire's shape, not a second one beside it. What an adapter reports here is reported to the
 * server verbatim, so a copy written out here would be a copy that could disagree with the thing
 * it is sent as — and the compiler would have no way to say which of the two was right.
 */
export type Model = components['schemas']['Model']

export type Talk = {
  /**
   * Say one thing, and report what happens until the agent is done.
   *
   * Never throws. Both SDKs report every kind of trouble by throwing, and what they throw is not
   * fit to show anyone; catching it here is what keeps a `try` out of every caller.
   */
  readonly say: (asked: Asked) => AsyncIterable<Told>

  /**
   * Ask it to stop what it is doing.
   *
   * The turn ends as `cancelled` rather than failed, and the conversation can be picked up again
   * afterwards — a person who interrupts wants to redirect it, not to lose it.
   */
  readonly stop: () => Promise<void>
}

/** What a person said, in the same words the server keeps it in. */
export type Asked = {
  readonly text: string
  /** Absent leaves the agent on its own default. We never choose one on its behalf. */
  readonly model?: string
  readonly effort?: string
}

export type Told =
  /** What the agent calls this conversation. Kept so a later turn can pick it up, and so a lost
   *  turn can be replayed. */
  | { readonly told: 'session'; readonly id: string }
  /** It was asked to pick up an earlier session and could not, so this turn starts from nothing.
   *  Only the adapter can tell this apart from a real failure — it is the one that recognises
   *  what its own agent's refusal looks like, and calling it a failure would send somebody
   *  looking for a fault that is not there. */
  | { readonly told: 'forgot' }
  | { readonly told: 'said'; readonly said: Said }
  | { readonly told: 'ended'; readonly why: Why }

/**
 * One thing said or done, in our words.
 *
 * A page shows every kind; only some are kept. Two are live-only because they exist to show a
 * turn in motion, and a message is written once and never revised — a row per streamed fragment
 * would be an update per fragment, and Postgres keeps every version of a row it updates.
 */
export type Said =
  | { readonly said: 'text'; readonly text: string }
  /** Live only. Worth watching, worth nothing afterwards — and Claude Code agrees with itself:
   *  the thinking in its own session file carries a signature and no readable text. */
  | { readonly said: 'thinking'; readonly text: string }
  /** Live only. It started something; the record of it is the `did` that follows. */
  | { readonly said: 'doing'; readonly name: string; readonly verb: string; readonly arg: string }
  /** Something went wrong and it carried on anyway. Neither speech nor a tool, and not the end of
   *  the turn — a page that folded this into a failure would be saying the turn is over when it
   *  is not. */
  | { readonly said: 'trouble'; readonly text: string }
  | {
      readonly said: 'did'
      /** The tool's own name, never translated. The set of tools is open — one MCP server adds as
       *  many as it likes — so a table mapping names to our words is wrong the day it is written. */
      readonly name: string
      /** A courtesy for tools this adapter recognises. A page with none still has `name`. */
      readonly verb: string
      readonly arg: string
      /** Absent when the tool never says how it went. Not everything reports a verdict, and
       *  inventing one would put a tick beside something nobody checked. */
      readonly ok?: boolean
      readonly excerpt: string
    }

/**
 * Why a turn ended.
 *
 * `unknown` is absent on purpose: an adapter that can still speak is an adapter that is still
 * alive, so it is never the one to say nobody knows. That belongs to whoever finds the turn
 * afterwards.
 */
export type Why =
  | { readonly why: 'done' }
  | { readonly why: 'cancelled' }
  /** `said` is shown to a person, so it owes them plain words rather than whatever was thrown. */
  | { readonly why: 'failed'; readonly said: string }

/**
 * How much of a tool's output is worth keeping.
 *
 * Enough to recognise what happened, never the whole thing. It belongs here rather than to either
 * adapter because it answers a question about the page, not about any agent: a person scanning a
 * conversation wants to see that a command ran and roughly what came back.
 */
const EXCERPT = 400

export function shorten(value: string): string {
  return value.length <= EXCERPT ? value : `${value.slice(0, EXCERPT - 1)}…`
}

/**
 * The text of a value that ought to be text.
 *
 * Everything an adapter reads comes out of somebody else's JSON, where a field can be missing,
 * renamed between versions, or an object. Anything that is not a string has nothing worth showing
 * in it, and stringifying it anyway puts `[object Object]` in front of a person.
 */
export function plain(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
