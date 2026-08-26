/**
 * Answering one question: drive the agent, and write down what it says.
 *
 * This runs alongside the check-in loop rather than inside it. A turn can take ten minutes, and a
 * machine that stops reporting for ten minutes is a machine its Space shows as gone — every
 * conversation on it would read as "nobody knows" while it was busy working.
 */

import type { components } from '../generated/api.ts'
import type { Agent, Asked, Said, Told, Why } from './agents/agent.ts'
import { shorten } from './agents/agent.ts'
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
  /** Where the agent works: this process's own directory, which is where it was connected. */
  readonly where: string
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
 * to answer for not being able to do it.
 */
export function startAnswering(
  api: Api,
  asking: Asking,
  agent: Agent,
  machine: Machine,
): Answering {
  const writing = writingInto(api, asking, machine)
  const talk = agent.talk(machine.where, asking.agentSession)

  return {
    conversationId: asking.conversationId,
    afterSeq: asking.afterSeq,
    stop: talk.stop,
    done: write(writing, asking, talk.say(whatToDo(asking, machine.handover)), machine.say),
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
  if (asking.goal === null) return asking.asked ?? { text: '' }

  const said = asking.asked === null ? [] : [`They have just said: ${asking.asked.text}`]

  return {
    text: [`You are carrying this on by yourself: ${asking.goal}`, ...said, canSay(handover)].join(
      '\n\n',
    ),
    ...(asking.asked?.model === undefined ? {} : { model: asking.asked.model }),
    ...(asking.asked?.effort === undefined ? {} : { effort: asking.asked.effort }),
  }
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
 * Writes down everything one turn produced.
 *
 * Every message carries a name built from the turn it belongs to and its place in it, so a write
 * whose answer was lost can be sent again and land in the same place. The count is local to this
 * turn: a turn that is being answered a second time is a turn nobody saw the end of, and that is
 * recovered by reading the agent's own record rather than by guessing where it got to.
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
      // What the agent said it was, unless the record is missing lines — then nobody can say.
      const how = whole ? ending(one.why) : LOST
      say(
        `answered ${asking.conversationId}: ${whole ? one.why.why : 'unknown, part of it was lost'}`,
      )
      await closing(writing, asking, how)
      return
    }

    const goes = one.told === 'forgot' ? { written: FORGOT } : where(one.said)

    if ('now' in goes) {
      writing.moment(goes.now)
      continue
    }

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
 * motion. Everything else is written, and nothing is both: a sentence sent down the live stream
 * *and* written into the transcript is the same sentence crossing the network twice, arriving
 * twice on the screen, and in two orders whenever a write is retried.
 */
function where(said: Said): { written: Written } | { now: Unkept } {
  if (said.said === 'thinking' || said.said === 'doing') return { now: said }
  if (said.said === 'text') return { written: { role: 'assistant', content: { text: said.text } } }
  if (said.said === 'trouble') {
    return { written: { role: 'activity', content: { activityType: 'trouble', text: said.text } } }
  }

  // Everything but the tag, so a tool that never said how it went stays a tool that never said.
  const { said: _kind, ...what } = said
  return { written: { role: 'tool', content: what } }
}

/**
 * Writes into one conversation, and tells the difference between not reaching the server and
 * being refused.
 *
 * Not reaching it is nothing to do about: the agent is already working, and stopping it over a
 * dropped connection would throw away the work. One line of a transcript is lost, and the turn
 * ending unclosed is what says so.
 *
 * Being refused is different in kind — it means this build and that server disagree about what a
 * message is, and every line of every turn will vanish the same way. Silence there would be a
 * machine that looks like it is working and writes nothing down.
 */
function writingInto(api: Api, asking: Asking, machine: Machine): Writing {
  const path = { params: { path: { id: asking.conversationId } } }
  const { say, until } = machine

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
    message: async (key, message) =>
      sent(async () =>
        api.POST('/machines/current/conversations/{id}/messages', {
          ...path,
          body: { key, message },
        }),
      ),

    session: async (id) => {
      // Same treatment: losing it means the next turn starts over and says so, which is honest but
      // worse than the turn it could have continued.
      await sent(async () =>
        api.PUT('/machines/current/conversations/{id}/session', { ...path, body: { session: id } }),
      )
    },

    moment: (said) => {
      void api.POST('/machines/current/conversations/{id}/live', { ...path, body: said })
    },
  }
}
