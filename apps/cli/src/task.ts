/**
 * What an agent says about the piece of work it was handed.
 *
 * Six commands, and every one is a verb and a sentence. Four of them are the name of a state —
 * `wait`, `sleep`, `done`, `cannot` — so an agent reading `handover task --help` is reading the
 * whole of what a piece of work can be, and nobody has to explain it in a prompt as well.
 *
 * **Nothing is typed here that the agent would have to guess.** Which conversation it is working
 * in comes out of the environment its own turn was started with, and the credential is the one
 * this machine already keeps on disk — the same file the agent could open for itself.
 */

import type { components } from '../generated/api.ts'
import { EVERY_KIND } from './agents/known-agents.ts'
import { apiFor, type Api } from './api.ts'
import { readAttachment } from './store.ts'

/** Set on every turn of a conversation somebody handed over. Absent means nobody did. */
const CONVERSATION = 'HANDOVER_CONVERSATION'

const HELP = `handover task — what to say about the piece of work you were handed

  new "<goal>"                    put a goal in front of whoever handed this to you
  new "<goal>" --to <agent>@<machine>
                                  open a piece of work for another agent, and carry on

  wait "<question>"               stop, and wait for them to answer
  sleep <when>                    stop until a moment: 3h, 45m, or 2026-09-03T12:00:00Z
  done "<what came of it>"        it is finished
  cannot "<why not>"              it cannot be done, and this is why

  output "<title>" "<text>"       write something down that is worth keeping.
                                  Writing the same title again revises it.

You are working in whichever conversation your turn belongs to; nothing here takes an id.`

export type Ran =
  | { readonly kind: 'did'; readonly said: string }
  /** Nothing was wrong with the command — there is just no piece of work here to say it about. */
  | { readonly kind: 'not-handed-over'; readonly said: string }
  | { readonly kind: 'no-such-command'; readonly said: string }
  | { readonly kind: 'wrong'; readonly said: string }

export type Doing = {
  readonly env: NodeJS.ProcessEnv
  readonly where: string
  /** Everything after `handover task`, in the order it was typed. */
  readonly words: readonly string[]
}

/**
 * Runs one of them, and says what came of it in a sentence the agent can act on.
 *
 * Every answer is a sentence rather than an exit code, because the thing reading it is an agent:
 * "nothing was handed over here" is something it can understand and stop doing, where a silent
 * failure is something it will try again.
 */
export async function runTask(doing: Doing): Promise<Ran> {
  const [verb, ...rest] = doing.words
  // Unset and set to nothing are the same thing: nobody handed this turn anything.
  const conversation = doing.env[CONVERSATION]?.trim()
  const held = await readAttachment(doing.where)

  if (verb === undefined || verb === '--help' || verb === 'help') return { kind: 'did', said: HELP }
  if (held === undefined) {
    return { kind: 'wrong', said: 'this machine is not connected to Handover' }
  }
  if (conversation === undefined || conversation === '') {
    return {
      kind: 'not-handed-over',
      said: 'nothing was handed over here, so there is nothing to say about',
    }
  }

  const at = { api: apiFor(held.origin, held.token), conversation, key: keyFor(verb, rest) }

  return oneOfThem(at, verb, rest)
}

/** The six, and nothing else. Each one a verb and a sentence. */
async function oneOfThem(at: At, verb: string, rest: readonly string[]): Promise<Ran> {
  switch (verb) {
    case 'new':
      return newWork(at, rest)
    case 'wait':
      return stops(at, { state: 'wait', question: joined(rest) }, 'told them, and stopped')
    case 'sleep':
      return sleep(at, rest)
    case 'done':
      return stops(at, { state: 'done', ending: 'done', text: joined(rest) }, 'said it is finished')
    case 'cannot':
      return stops(
        at,
        { state: 'done', ending: 'cannot', text: joined(rest) },
        'said it cannot be done',
      )
    case 'output':
      return output(at, rest)
    default:
      return { kind: 'no-such-command', said: `no such command: ${verb}\n\n${HELP}` }
  }
}

type At = { readonly api: Api; readonly conversation: string; readonly key: string }

/**
 * Everything after the verb that is not a flag, as one sentence.
 *
 * A flag takes the word after it with it, or a goal would end up carrying `codex@build-server-1`
 * on the end of it. Quoting is the shell's business — what arrives here is already words.
 */
function joined(rest: readonly string[]): string {
  const said: string[] = []
  for (let at = 0; at < rest.length; at += 1) {
    if (rest[at]?.startsWith('--') === true) at += 1
    else said.push(rest[at] ?? '')
  }

  return said.join(' ').trim()
}

/**
 * The name this goes in under, so saying it twice says it once.
 *
 * Built from what was said rather than minted, because an agent that runs the same command twice
 * — because the first one's answer was lost — means it once.
 */
function keyFor(verb: string, rest: readonly string[]): string {
  return `${verb}:${rest.join(' ')}`.slice(0, 200)
}

async function newWork(at: At, rest: readonly string[]): Promise<Ran> {
  const goal = joined(rest)
  if (goal === '') return { kind: 'wrong', said: 'say what the goal is' }

  const to = flag(rest, '--to')
  if (to === undefined) return proposes(at, goal)

  const [agentKind, machine] = to.split('@')
  if (machine === undefined || agentKind === undefined || !isKind(agentKind)) {
    return { kind: 'wrong', said: `--to looks like ${EVERY_KIND.join('|')}@<machine>` }
  }

  const off = await at.api.POST('/machines/current/conversations/{id}/task/handed-off', {
    params: { path: { id: at.conversation } },
    body: { key: at.key, goal, machine, agentKind },
  })

  return came(off.response, `handed it to ${to}`)
}

/**
 * A goal put in front of a person to agree to, which is a message and nothing else.
 *
 * It changes no state and creates nothing — it is a line for somebody to read. So it goes down
 * the path a machine already writes lines by, and this side of the system needs nothing new for
 * it at all.
 */
async function proposes(at: At, goal: string): Promise<Ran> {
  const put = await at.api.POST('/machines/current/conversations/{id}/messages', {
    params: { path: { id: at.conversation } },
    body: {
      key: at.key,
      message: { role: 'activity', content: { activityType: 'proposed', text: goal } },
    },
  })

  return came(put.response, 'put it in front of them; they have to agree before it starts')
}

async function sleep(at: At, rest: readonly string[]): Promise<Ran> {
  const until = moment(joined(rest))
  if (until === undefined) {
    return { kind: 'wrong', said: 'say when: 3h, 45m, or a time like 2026-09-03T12:00:00Z' }
  }

  const when = until.toISOString()

  return stops(at, { state: 'sleep', until: when }, `asleep until ${when}`)
}

async function output(at: At, rest: readonly string[]): Promise<Ran> {
  const [title, ...body] = rest.filter((word) => !word.startsWith('--'))
  const text = body.join(' ').trim()
  if (title === undefined || text === '') {
    return { kind: 'wrong', said: 'say a title and then what it says' }
  }

  const wrote = await at.api.PUT('/machines/current/conversations/{id}/task/outputs/{title}', {
    params: { path: { id: at.conversation, title } },
    body: { text },
  })

  return came(wrote.response, `wrote down "${title}"`)
}

/**
 * A moment, either as a length of time from now or as a time of its own.
 *
 * Both, because both are how somebody actually says it: "look again in ten minutes" and "at noon
 * on Thursday" are the same kind of instruction and neither should need converting by hand.
 */
function moment(said: string): Date | undefined {
  const every = /^(\d+)(m|h|d)$/u.exec(said.trim())
  if (every !== null) {
    const much = Number(every[1])
    const long = { m: 60_000, h: 3_600_000, d: 86_400_000 }[every[2] as 'm' | 'h' | 'd']
    return new Date(Date.now() + much * long)
  }

  const at = new Date(said.trim())
  return Number.isNaN(at.getTime()) ? undefined : at
}

/** Whether that is an agent this deployment knows, checked here rather than sent to be refused. */
function isKind(value: string): value is Kind {
  return EVERY_KIND.includes(value)
}

type Kind = components['schemas']['OpenTaskFor']['agentKind']

function flag(rest: readonly string[], name: string): string | undefined {
  const at = rest.indexOf(name)
  return at === -1 ? undefined : rest[at + 1]
}

/** How it stopped, in the contract's own words. Three, and `working` is not one of them. */
type How = components['schemas']['StopWorking']['how']

/** It stops working, and says why. The one place a piece of work leaves `working`. */
async function stops(at: At, how: How, well: string): Promise<Ran> {
  const stopped = await at.api.PATCH('/machines/current/conversations/{id}/task', {
    params: { path: { id: at.conversation } },
    body: { key: at.key, how },
  })

  return came(stopped.response, well)
}

/** What came back, turned into something an agent can act on rather than an exit code. */
function came(answer: Response, well: string): Ran {
  if (answer.ok) return { kind: 'did', said: well }
  // Both mean the same thing from this side: no piece of work here to say anything about. One is
  // "nobody handed this conversation over", the other is "this machine was never given it".
  if (answer.status === 409 || answer.status === 404) {
    return {
      kind: 'not-handed-over',
      said: 'nothing was handed over here, so there is nothing to say about',
    }
  }

  return { kind: 'wrong', said: `Handover would not take that (${String(answer.status)})` }
}
