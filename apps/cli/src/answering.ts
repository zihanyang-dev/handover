/**
 * Answering one question: drive the agent, and write down what it says.
 *
 * This runs alongside the check-in loop rather than inside it. A turn can take ten minutes, and a
 * machine that stops reporting for ten minutes is a machine its Space shows as gone — every
 * conversation on it would read as "nobody knows" while it was busy working.
 */

import type { components } from '../generated/api.ts'
import type { Agent, Said, Told, Why } from './agents/agent.ts'
import { shorten } from './agents/agent.ts'
import type { Api } from './api.ts'

/** What a call that reached nobody comes back as. Not a refusal, and not worth saying twice. */
const NO_ANSWER = 503

/** What the server handed over: one question, and what is needed to answer it. */
export type Asking = components['schemas']['SomethingToAnswer']

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
  readonly message: (key: string, message: Written) => Promise<void>
  /** What the agent calls this conversation, so a later turn can ask it to remember. */
  readonly session: (id: string) => Promise<void>
  /**
   * One moment, to whoever is watching right now.
   *
   * Not awaited by the turn and never retried: it is worth something for about a second, and a
   * turn that stopped to make sure somebody saw it would be a turn held up by a browser.
   */
  readonly moment: (said: Said) => void
}

export type Answering = {
  readonly conversationId: string
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
  readonly env: NodeJS.ProcessEnv
  readonly say: (line: string) => void
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
  const writing = writingInto(api, asking, machine.say)
  const talk = agent.talk(machine.where, asking.agentSession)

  return {
    conversationId: asking.conversationId,
    stop: talk.stop,
    done: write(writing, asking, talk.say(asking.asked), machine.say),
  }
}

async function closing(writing: Writing, asking: Asking, content: Happened): Promise<void> {
  await writing.message(`${asking.askedSeq}/end`, { role: 'activity', content })
}

/** Closes a turn that never started. The only way in from outside, for exactly that case. */
export async function endTurn(
  api: Api,
  asking: Asking,
  say: Speaks,
  content: Happened,
): Promise<void> {
  await closing(writingInto(api, asking, say), asking, content)
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
async function write(writing: Writing, asking: Asking, told: AsyncIterable<Told>, say: Speaks) {
  let wrote = 0

  for await (const one of told) {
    if (one.told === 'session') {
      await writing.session(one.id)
      continue
    }

    if (one.told === 'ended') {
      say(`answered ${asking.conversationId}: ${one.why.why}`)
      await closing(writing, asking, ending(one.why))
      return
    }

    // Everything goes to whoever is watching, including the two kinds nothing keeps: what it is
    // thinking, and that it has started something. That is the whole of what live adds.
    if (one.told === 'said') writing.moment(one.said)

    const message = one.told === 'forgot' ? FORGOT : keep(one.said)
    if (message === undefined) continue

    wrote += 1
    await writing.message(`${asking.askedSeq}/${wrote}`, message)
  }

  // It stopped talking without saying how it went. Nobody can say either, and a turn left open is
  // one a page shows as still working for as long as this machine keeps reporting. The three
  // outcomes are the caller's to decide, and this is the caller.
  say(`${asking.conversationId} ended without saying how`)
  await closing(writing, asking, { activityType: 'unknown' })
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
 * What is worth keeping out of everything the agent said.
 *
 * Two kinds are not: what it was thinking, and that it had started something. Both exist to show
 * a turn in motion to somebody watching it, and neither is worth anything once it is over.
 */
function keep(said: Said): Written | undefined {
  if (said.said === 'text') return { role: 'assistant', content: { text: said.text } } as const
  if (said.said === 'trouble') {
    return { role: 'activity', content: { activityType: 'trouble', text: said.text } } as const
  }
  if (said.said === 'did') {
    // Everything but the tag, so a tool that never said how it went stays a tool that never said.
    const { said: _kind, ...what } = said
    return { role: 'tool', content: what } as const
  }

  return undefined
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
function writingInto(api: Api, asking: Asking, say: Speaks): Writing {
  const path = { params: { path: { id: asking.conversationId } } }

  return {
    message: async (key, message) => {
      const sent = await api.POST('/machines/current/conversations/{id}/messages', {
        ...path,
        body: { key, message },
      })

      const refused = sent.response.status >= 400 && sent.response.status !== NO_ANSWER
      if (refused) {
        say(`the server refused a message (${sent.response.status}); it is not being kept`)
      }
    },

    session: async (id) => {
      await api.PUT('/machines/current/conversations/{id}/session', {
        ...path,
        body: { session: id },
      })
    },

    moment: (said) => {
      void api.POST('/machines/current/conversations/{id}/live', { ...path, body: said })
    },
  }
}

type Speaks = (line: string) => void
