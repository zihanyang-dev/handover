/**
 * Answering one question: drive the agent, and write down what it says.
 *
 * This runs alongside the check-in loop rather than inside it. A turn can take ten minutes, and a
 * machine that stops reporting for ten minutes is a machine its Space shows as gone — every
 * conversation on it would read as "nobody knows" while it was busy working.
 */

import { fitsInPiece, textPieces } from '@handover/universal'
import type { components } from '../generated/api.ts'
import {
  type Agent,
  type Asked,
  EXCERPT,
  type Said,
  type Told,
  type Why,
  shorten,
} from './agents/agent.ts'
import { NO_ANSWER, type Api } from './api.ts'
import { sleep } from './sleeping.ts'

/**
 * How long one write keeps trying before its turn is called `unknown`.
 *
 * Long enough to sit out the network coming back, and bounded because a turn has to end: a turn
 * that never ends is one a page shows as still working forever. Every attempt carries the same
 * name, so landing twice is landing once.
 */
const KEEP_TRYING_MS = 120_000

const BETWEEN_TRIES_SECONDS = 2

/** Batches noisy provider updates before each cross-instance NOTIFY without making them feel late. */
const LIVE_OUTPUT_EVERY_MS = 75

/** What the server handed over: one question, and what is needed to answer it. */
export type Asking = components['schemas']['SomethingToAnswer']

/** Which turn somebody asked this machine to stop. Named by turn, not by conversation. */
export type Stopping = components['schemas']['StopWanted']

/** The two an agent reports that are never written down. The contract's own name for them. */
type Unkept = components['schemas']['Unkept']

/** One message as the server will accept it. Written down here so a wrong shape cannot compile. */
type Written = components['schemas']['MachineMessage']['message']

/** What an activity carries. Open on purpose: a new kind of one is a value, not a release. */
type Happened = Extract<Written, { role: 'activity' }>['content']

/**
 * Writing one message into the turn being answered.
 *
 * The conversation, the name each message goes by, and who to tell when the server says no are
 * all settled once, here, rather than carried through every call that writes a line.
 */
type Writing = {
  /** Whether it is in there. False is a line of the transcript that is gone for good. */
  readonly message: (key: string, message: Written) => Promise<boolean>
  /** What the agent calls this conversation, so a later turn can ask it to remember. */
  readonly session: (id: string) => Promise<void>
  /**
   * One thing that is never written down, to whoever is watching right now.
   *
   * Not awaited by the turn and never retried: it is worth something for about a second, and a
   * turn that stopped to make sure somebody saw it would be a turn held up by a browser. What is
   * written down needs neither — the write announces itself.
   */
  readonly moment: (said: Unkept) => void
}

export type Answering = {
  readonly conversationId: string
  /** Which turn of it. A stop names one, and one that names another turn is not about this. */
  readonly afterSeq: number
  /** Ask the agent to stop. The turn ends as cancelled, and the conversation stays usable. */
  readonly stop: () => Promise<void>
  /** Settles when there is nothing left to write. Never rejects. */
  readonly done: Promise<void>
}

/**
 * The machine an agent runs on, as far as answering is concerned.
 *
 * Not called `Working`: that word already means the state a conversation is in, and one name for
 * two things is one of them being read as the other.
 */
export type Machine = {
  /**
   * The folder every conversation gets one of its own under.
   *
   * Not this process's directory, which is what it used to be. A machine ran one thing at a time
   * and that thing ran where `handover connect` was typed; several at once in one directory is
   * the exact failure the old limit existed to prevent. See `workspace.ts`.
   */
  readonly workRoot: string
  /** How to run this program again, so an agent can be told something that works. */
  readonly handover: string
  readonly env: NodeJS.ProcessEnv
  readonly say: (line: string) => void
  /**
   * Raised when this machine is stopping.
   *
   * Part of what the machine is, rather than something handed to each thing it does: a write that
   * keeps trying is a write that would hold the whole process open, and whether it should is a
   * fact about the machine and not about that write.
   */
  readonly until: AbortSignal
}

/**
 * Starts answering, and hands back a way to stop it.
 *
 * Nothing is awaited here. The caller is a loop that has to keep reporting, and holding it until
 * the agent finished is the thing this file exists to avoid.
 *
 * Which agent is the caller's to find: it is the one that took the work, and so the one that has
 * to answer for not being able to do it. Where it works is the caller's too, and for the same
 * reason — the folder has to exist before anything is started in it.
 */
export function startAnswering(
  api: Api,
  asking: Asking,
  agent: Agent,
  on: { readonly machine: Machine; readonly where: string },
): Answering {
  const writing = writingInto(api, asking, on.machine)
  const talk = agent.talk(on.where, asking.agentSession)

  return {
    conversationId: asking.conversationId,
    afterSeq: asking.afterSeq,
    stop: talk.stop,
    done: write(writing, asking, talk.say(whatToDo(asking, on.machine.handover)), on.machine.say),
  }
}

/**
 * How to stop, which an agent has to be told every time or it will not stop at all.
 *
 * The command is spelt out rather than named, because "run `handover`" is an assumption about a
 * PATH nobody checked. What is handed over is how this very process was started, which is a thing
 * that is already known to work on this machine.
 */
function canSay(handover: string): string {
  return `When you need something from them, or you are finished, say so by running these:

  ${handover} task wait "<question>"     stop, and wait for them to answer
  ${handover} task sleep <when>          stop until a moment: 3h, 45m, or an ISO time
  ${handover} task done "<what came of it>"
  ${handover} task cannot "<why not>"
  ${handover} task new "<goal>" --to <agent>@<machine>    hand a piece of it to another agent
  ${handover} task output "<title>" "<text>"              write something worth keeping

Run \`${handover} task --help\` for the whole list. Until you say one of these, you will be given
another turn as soon as this one ends, for as long as it takes.`
}

/**
 * What this turn is, put to the agent.
 *
 * Two kinds of turn. One answers a question somebody asked, and is that question. One carries on
 * a piece of work nobody is sitting in front of, and has no question at all — so it is told what
 * the work is for, what it may say back, and whatever the person said if they said anything.
 *
 * All three every time. Between two turns the agent's own memory may not have survived (`03`
 * decision ⑨), and a turn that woke up with nothing still has to know what it is doing and how to
 * stop — an agent that cannot say "I am waiting on you" carries on for ever instead.
 */
function whatToDo(asking: Asking, handover: string): Asked {
  const chosen = {
    ...(asking.model === null ? {} : { model: asking.model }),
    ...(asking.effort === null ? {} : { effort: asking.effort }),
  }

  if (asking.goal === null) return { text: whatWasSaid(asking.asked), ...chosen }

  const said =
    asking.asked.length === 0 ? [] : [`They have just said: ${whatWasSaid(asking.asked)}`]

  return {
    text: [`You are carrying this on by yourself: ${asking.goal}`, ...said, canSay(handover)].join(
      '\n\n',
    ),
    ...chosen,
  }
}

/**
 * The lines of this turn, as one thing to read.
 *
 * Named only when there is more than one of them. Two people asked two things and the agent has
 * to be able to answer each of them to the person who asked — unnamed, it gets one run-on
 * question from nobody. One line needs no name: there is nobody it could be confused with, and
 * `Kai: ` in front of every message a person sends to their own agent is noise.
 *
 * A line from before names had a `who` of null, and then it goes in as itself.
 */
function whatWasSaid(said: Asking['asked']): string {
  if (said.length === 1) return said[0]?.text ?? ''

  return said.map((one) => (one.who === null ? one.text : `${one.who}: ${one.text}`)).join('\n\n')
}

async function closing(writing: Writing, asking: Asking, content: Happened): Promise<void> {
  await writing.message(`${asking.afterSeq}/end`, { role: 'activity', content })
}

/**
 * How a turn ended, given that part of it never made it into the record.
 *
 * `unknown`, whatever the agent said. It may well have done everything it was asked — that is
 * exactly why this is not `failed`, which invites somebody to ask for it all over again — but the
 * transcript is missing lines, and a turn shown as finished beside a record with holes in it is
 * the page saying something it cannot know.
 */
const LOST = { activityType: 'unknown' } as const

/** Closes a turn that never started. The only way in from outside, for exactly that case. */
export async function endTurn(
  api: Api,
  asking: Asking,
  machine: Machine,
  content: Happened,
): Promise<void> {
  await closing(writingInto(api, asking, machine), asking, content)
}

/** Said before anything else in a turn the agent could not pick up where it left off. */
const FORGOT = { role: 'activity', content: { activityType: 'forgot' } } as const

/**
 * Says the folder this conversation had been working in was not there any more.
 *
 * Written before the turn runs, because by the time the agent has said anything it has said it
 * about an empty directory. The same kind of thing as an agent that could not remember the last
 * turn, and kept apart from it because they are not the same fact: one is the agent's memory,
 * this is the work itself. Nothing is broken by it — the folder is made again and the turn starts
 * from what it can see — but a transcript that did not say so would have the agent looking as
 * though it had lost the work.
 */
export async function sayItStartedOver(api: Api, asking: Asking, machine: Machine): Promise<void> {
  await writingInto(api, asking, machine).message(`${asking.afterSeq}/started-over`, {
    role: 'activity',
    content: { activityType: 'started-over' },
  })
}

/** How a turn the agent finished is closed, and what is said about it out loud. */
async function ended(
  writing: Writing,
  asking: Asking,
  say: (line: string) => void,
  /** What the agent said, and whether every line of the turn before it landed. */
  how: { readonly why: Why; readonly whole: boolean },
): Promise<void> {
  // What the agent said it was, unless the record is missing lines — then nobody can say.
  const said = how.whole ? how.why.why : 'unknown, part of it was lost'
  say(`answered ${asking.conversationId}: ${said}`)
  await closing(writing, asking, how.whole ? ending(how.why) : LOST)
}

/**
 * Writes down everything one turn produced.
 *
 * Every message carries a name built from the turn and its place in it, so a response lost after
 * the write can be retried without making a second line.
 */
async function write(
  writing: Writing,
  asking: Asking,
  told: AsyncIterable<Told>,
  say: (line: string) => void,
) {
  let wrote = 0
  let whole = true

  for await (const one of told) {
    if (one.told === 'session') {
      await writing.session(one.id)
      continue
    }

    if (one.told === 'ended') {
      await ended(writing, asking, say, { why: one.why, whole })
      return
    }

    const goes: { written?: Written; now?: readonly Unkept[] } =
      one.told === 'forgot' ? { written: FORGOT } : where(one.said)

    // Whatever is only worth seeing now goes first: a tool line landing before its own output
    // would put the excerpt on screen and then the whole of it underneath, in that order.
    for (const now of goes.now ?? []) writing.moment(now)
    if (goes.written === undefined) continue

    wrote += 1
    // Never short-circuited: a turn goes on being written down after one line is lost, because
    // what did land is still worth having. What it changes is only how the turn is allowed to end.
    whole = (await writing.message(`${asking.afterSeq}/${wrote}`, goes.written)) && whole
  }

  // It stopped talking without saying how it went. Nobody can say either, and a turn left open is
  // one a page shows as still working for as long as this machine keeps reporting. The three
  // outcomes are the caller's to decide, and this is the caller.
  say(`${asking.conversationId} ended without saying how`)
  await closing(writing, asking, LOST)
}

/**
 * How the turn ended, as the activity that closes it.
 *
 * A failure carries its words under the same name trouble does, because they are the same kind of
 * thing — a sentence for a person — and a page that had to know two names for it would show one
 * of them as nothing. Bounded for the same reason a tool's output is: what arrives here is
 * somebody else's error, and an agent that dumps a stack trace should cost one line, not a page.
 */
function ending(why: Why): Happened {
  return why.why === 'failed'
    ? { activityType: 'failed', text: shorten(why.said) }
    : { activityType: why.why }
}

/**
 * Where one thing the agent said goes: into the transcript, or only to whoever is watching now.
 *
 * One function and not two, because it is one question. Two kinds are never written down — what
 * it was thinking, and that it had started something — and both exist only to show a turn in
 * motion. Nothing else may be *the same words* in both places: a sentence sent down the live
 * stream and written into the transcript crosses the network twice, arrives twice on the screen,
 * and in two orders whenever a write is retried.
 *
 * A finished tool is the one thing that is both, and only because the two are different lengths
 * on purpose — `prd.md` 03 ⑦ promises the whole output while it runs and the first paragraph
 * afterwards. When they would be the same words, {@link pieces} sends nothing.
 */
function where(said: Said): { written?: Written; now?: readonly Unkept[] } {
  // The three that are only ever worth seeing now. `output` is not reported by an adapter — it is
  // made here, out of the whole of what a tool printed — but it arrives through the same door.
  if (said.said === 'thinking' || said.said === 'doing' || said.said === 'output') {
    return { now: [said] }
  }
  if (said.said === 'text') return { written: { role: 'assistant', content: { text: said.text } } }
  if (said.said === 'trouble') {
    return { written: { role: 'activity', content: { activityType: 'trouble', text: said.text } } }
  }

  // Everything but the tag and the live-only output, so a tool that never said how it went stays
  // a tool that never said.
  const { said: _kind, output, ...what } = said

  return { now: pieces(what.callId, output), written: { role: 'tool', content: what } }
}

/**
 * A command's output, cut into pieces small enough to cross `NOTIFY`.
 *
 * Nothing when there is none, and nothing when it is no longer than the excerpt already going
 * into the transcript — pushing it then would be the same words arriving twice, which is the one
 * thing {@link where} exists to prevent.
 */
function pieces(callId: string | undefined, output: string | undefined): readonly Unkept[] {
  if (callId === undefined || output === undefined || output.length <= EXCERPT) return []

  return textPieces(output).map(({ at, text }) => ({ said: 'output', callId, at, text }))
}

type LiveWriter = {
  readonly push: (said: Unkept) => void
  readonly drain: () => Promise<void>
}

/**
 * A serial, short-cadence writer for ephemeral events, bounded by transport-sized pieces.
 *
 * A send that fails is dropped and nothing is told. What goes through here is the live preview of
 * an agent's output; the durable copy is written by the turn itself when it ends. Retrying would
 * put the same words in twice, and reporting it would be an error about a preview frame. What
 * must not be dropped is the chain — one failure may not stop every later piece from being
 * offered — which is why the `.catch` in {@link enqueue} settles it rather than leaving it
 * rejected.
 */
function liveWriter(send: (said: Unkept) => Promise<void>): LiveWriter {
  let sent = Promise.resolve()
  let pendingOutput: Extract<Unkept, { readonly said: 'output' }>[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function enqueue(said: Unkept): void {
    const sendOne = async (): Promise<void> => {
      await send(said)
    }
    sent = sent.then(sendOne).catch(() => undefined)
  }

  function flush(): void {
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    flushTimer = undefined

    const batch = pendingOutput
    pendingOutput = []
    for (const output of batch) enqueue(output)
  }

  function hold(next: Extract<Unkept, { readonly said: 'output' }>): void {
    const previous = pendingOutput.at(-1)
    const joinsPrevious =
      previous?.callId === next.callId &&
      previous.at + previous.text.length === next.at &&
      fitsInPiece(`${previous.text}${next.text}`)

    if (joinsPrevious) {
      pendingOutput[pendingOutput.length - 1] = {
        ...previous,
        text: `${previous.text}${next.text}`,
      }
    } else {
      pendingOutput.push(next)
    }

    if (flushTimer !== undefined) return
    flushTimer = setTimeout(flush, LIVE_OUTPUT_EVERY_MS)
    flushTimer.unref()
  }

  function push(said: Unkept): void {
    if (said.said === 'output') {
      hold(said)
      return
    }

    flush()
    enqueue(said)
  }

  async function drain(): Promise<void> {
    flush()
    await sent
  }

  return { push, drain }
}

function writingInto(api: Api, asking: Asking, machine: Machine): Writing {
  const path = { params: { path: { id: asking.conversationId } } }
  const { say, until } = machine
  const live = liveWriter(async (said) => {
    await api.POST('/machines/current/conversations/{id}/live', { ...path, body: said })
  })

  /**
   * Sends one thing until it is in, or until it is certain it never will be.
   *
   * The three answers are different in kind. Accepted is done. Refused — anything but a 503 — means
   * this build and that server disagree about what a message is, and every attempt after it would
   * be refused the same way. Nobody answering is a network, and a network comes back; the name on
   * the message is what makes trying again safe, so trying again is what happens.
   */
  async function sent(send: () => Promise<{ response: Response }>): Promise<boolean> {
    const giveUpAt = Date.now() + KEEP_TRYING_MS

    for (;;) {
      const answered = await send()
      if (answered.response.ok) return true

      if (answered.response.status !== NO_ANSWER) {
        say(`the server refused a message (${answered.response.status}); it is not being kept`)
        return false
      }

      if (until.aborted || Date.now() > giveUpAt) return false
      await sleep(BETWEEN_TRIES_SECONDS, until)
    }
  }

  return {
    message: async (key, message) => {
      // A durable result must not overtake the live fragments that explain it. Waiting happens
      // here, not in the adapter loop: moments are still accepted without holding up the agent.
      await live.drain()
      return sent(async () =>
        api.POST('/machines/current/conversations/{id}/messages', {
          ...path,
          body: { key, message },
        }),
      )
    },

    session: async (id) => {
      // Same treatment: losing it means the next turn starts over and says so, which is honest but
      // worse than the turn it could have continued.
      await sent(async () =>
        api.PUT('/machines/current/conversations/{id}/session', { ...path, body: { session: id } }),
      )
    },

    moment: live.push,
  }
}
