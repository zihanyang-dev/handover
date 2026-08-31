/**
 * Driving Claude Code.
 *
 * Through Anthropic's own SDK, pointed at the copy already on this machine: the person's login,
 * their subscription and their settings all live in that CLI, and a second copy of it here would
 * be a second thing to keep signed in.
 */

import {
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import {
  type Agent,
  type Asked,
  type Model,
  type Said,
  type Talk,
  type Told,
  plain,
  shorten,
} from './agent.ts'
import { onPath } from './on-path.ts'

/** The binary this drives. Found on the PATH captured when the machine was connected. */
const COMMAND = 'claude'

/** Tools this adapter recognises well enough to say what they did in a word. */
const VERBS: Record<string, { readonly verb: string; readonly arg: (input: Input) => string }> = {
  Read: { verb: 'read', arg: (i) => file(i['file_path']) },
  Write: { verb: 'wrote', arg: (i) => file(i['file_path']) },
  Edit: { verb: 'edited', arg: (i) => file(i['file_path']) },
  NotebookEdit: { verb: 'edited', arg: (i) => file(i['notebook_path']) },
  Bash: { verb: 'ran', arg: (i) => plain(i['command']) },
  Grep: { verb: 'searched', arg: (i) => plain(i['pattern']) },
  Glob: { verb: 'looked for', arg: (i) => plain(i['pattern']) },
  WebFetch: { verb: 'fetched', arg: (i) => plain(i['url']) },
  WebSearch: { verb: 'searched the web', arg: (i) => plain(i['query']) },
  Task: { verb: 'delegated', arg: (i) => plain(i['description']) },
  // A count, not a list: a plan belongs on the page as a plan, and this line is only meant to
  // say that one was made. A missing or misshapen field counts as nothing rather than throwing.
  TodoWrite: {
    verb: 'planned',
    arg: (i) => `${Array.isArray(i['todos']) ? i['todos'].length : 0} steps`,
  },
}

type Input = Record<string, unknown>

/** A tool call that has begun, held until its result comes back to be paired with it. */
type Call = { readonly name: string; readonly verb: string; readonly arg: string }

/** A path is easier to recognise by its last part; the rest is the same for every line. */
function file(value: unknown): string {
  const [last] = plain(value).split('/').slice(-1)
  return last ?? ''
}

/**
 * What a tool call did, in our words.
 *
 * An unrecognised tool keeps its own name and no verb — the set is open, and one MCP server adds
 * as many as it likes, so a page that can only show tools from a list would go blind the first
 * time somebody connected one.
 */
function asDoing(name: string, input: Input): { verb: string; arg: string } {
  const known = VERBS[name]
  if (known === undefined) return { verb: '', arg: '' }

  return { verb: known.verb, arg: known.arg(input) }
}

function blocksOf(message: unknown): readonly Record<string, unknown>[] {
  const content = (message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

/**
 * Turns Claude's messages into ours, live or replayed.
 *
 * A tool call and its result arrive as two blocks in two messages, so what a page finally shows
 * as one line is assembled here — a call is remembered until its result comes back. Nothing is
 * written until then: the row for a tool is written once, when there is something to say about it.
 */
export function fold(): (message: unknown, source?: 'assistant' | 'user') => readonly Said[] {
  const started = new Map<string, Call>()

  return (message, source = 'assistant') =>
    blocksOf(message).flatMap((block): Said[] => {
      if (source === 'assistant' && block['type'] === 'text')
        return [{ said: 'text', text: plain(block['text']) }]
      if (source === 'assistant' && block['type'] === 'thinking')
        return [{ said: 'thinking', text: plain(block['thinking']) }]
      if (source === 'assistant' && block['type'] === 'tool_use') return [beginning(started, block)]
      if (source === 'user' && block['type'] === 'tool_result') return finishing(started, block)

      return []
    })
}

function beginning(started: Map<string, Call>, block: Record<string, unknown>): Said {
  const callId = plain(block['id'])
  const name = plain(block['name'])
  const { verb, arg } = asDoing(name, (block['input'] ?? {}) as Input)
  started.set(callId, { name, verb, arg })

  return { said: 'doing', callId, name, verb, arg }
}

function finishing(started: Map<string, Call>, block: Record<string, unknown>): Said[] {
  const id = plain(block['tool_use_id'])
  const call = started.get(id)
  if (call === undefined) return []

  started.delete(id)
  return [
    {
      said: 'did',
      callId: id,
      ...call,
      ok: block['is_error'] !== true,
      excerpt: shorten(readable(block['content'])),
      // The whole of it as well, for whoever is watching, and never written down.
      output: readable(block['content']),
    },
  ]
}

function readable(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map((part: Record<string, unknown>) => plain(part['text'])).join(' ')
}

/**
 * Input that never arrives, so the CLI starts and waits instead of doing anything.
 *
 * Not an empty generator: one of those ends immediately, and the CLI would shut down before it
 * could be asked anything.
 */
const SILENCE: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: async () => new Promise<never>(() => {}) }),
}

/**
 * What this agent lets a person choose.
 *
 * Asked of the CLI itself rather than kept as a list here: which models an account may use is not
 * something this program can know, and a list it carried would be wrong for somebody the day
 * their plan changed. The prompt never yields, so the CLI starts, answers, and is stopped without
 * a single model call.
 */
async function offers(where: string, env: NodeJS.ProcessEnv): Promise<readonly Model[]> {
  const claude = await onPath(COMMAND, env)
  if (claude === undefined) return []

  const stopping = new AbortController()
  const asking = query({
    prompt: SILENCE,
    options: { cwd: where, pathToClaudeCodeExecutable: claude, abortController: stopping },
  })

  try {
    const models = await asking.supportedModels()

    return models.map((one) => ({
      id: one.value,
      name: one.displayName,
      about: one.description,
      efforts: one.supportedEffortLevels ?? [],
      // Claude Code publishes its default as a row of its own, named for what it is, so the
      // list already says which one somebody gets by saying nothing.
      isDefault: one.value === 'default',
    }))
  } finally {
    // It was started to answer one question and was never given anything to do. Both are needed:
    // closing stops us listening, aborting stops it running. Leaving it would be a CLI sitting on
    // this machine for as long as this program lives, waiting for input that never comes.
    asking.close()
    stopping.abort()
  }
}

/**
 * The one thing Claude Code refuses in a way that is not a fault: it no longer has that session.
 *
 * Takes what was said rather than what was thrown, because it arrives both ways: sometimes as an
 * error result on the stream, sometimes as a throw on the way out. Read only in the throw, the
 * result reached the transcript first — and a turn that merely started over was written down as
 * failed, which is the one thing the page promises never to call it.
 */
function looksForgotten(said: string): boolean {
  return said.includes('No conversation found')
}

/** What to show a person when a turn ends badly. Never the raw throw, which is for us. */
function plainly(trouble: unknown): string {
  const said = String((trouble as Error | undefined)?.message ?? '').trim()
  return said === '' ? 'Claude Code stopped without saying why.' : said
}

/**
 * Why a turn ended badly, in the CLI's own words.
 *
 * Taken from the result it sent rather than composed here: an error result carries `errors`, and a
 * success-shaped result that is nonetheless an error carries the text in `result`. Reaching for
 * `message` — which a result does not have — was this file inventing a sentence while throwing
 * away the one the CLI had already written.
 */
function whyItFailed(message: SDKResultMessage): string {
  const said = message.subtype === 'success' ? message.result : message.errors.join('; ')
  const trimmed = said.trim()

  return trimmed === '' ? 'Claude Code stopped without saying why.' : trimmed
}

/**
 * One of the CLI's messages, in ours.
 *
 * Typed against the SDK's own union rather than a shape written out here. Only four kinds matter
 * and the rest are ignored, which is what keeps a newer CLI from breaking this — but the four are
 * read through the SDK's fields, not through guesses about them.
 */
export function toldFrom(
  message: SDKMessage,
  translate: (message: unknown, source?: 'assistant' | 'user') => readonly Said[],
): Told[] {
  if (message.type === 'system' && message.subtype === 'init') {
    return [{ told: 'session', id: message.session_id }]
  }
  if (message.type === 'assistant' || message.type === 'user') {
    // Nested agent traffic belongs inside the Agent tool that owns it. Promoting its prompts,
    // answers or tool calls would expose internal instructions as top-level conversation lines.
    if (message.parent_tool_use_id !== null) return []
    return translate(message.message, message.type).map((said) => ({ told: 'said', said }) as const)
  }
  if (message.type === 'result') {
    // `is_error` on a success-shaped result is the CLI saying the turn failed anyway. Reading only
    // the subtype recorded those as done — a turn that went wrong, written down as finished.
    const done = message.subtype === 'success' && !message.is_error

    return [
      done
        ? { told: 'ended', why: { why: 'done' } }
        : { told: 'ended', why: { why: 'failed', said: whyItFailed(message) } },
    ]
  }

  return []
}

function settings(
  running: { readonly where: string; readonly claude: string; readonly env: NodeJS.ProcessEnv },
  resume: string | null,
  asked: Asked,
) {
  return {
    cwd: running.where,
    pathToClaudeCodeExecutable: running.claude,
    // Handed on rather than left to be inherited, because one variable in it says which
    // conversation this turn belongs to — which is how `handover task` knows what it is talking
    // about without anybody typing an id.
    env: running.env,
    // Nobody is standing at this machine to answer a prompt, so anything that asks would hang
    // there until the turn was given up on.
    //
    // What bounds it is the account it runs as, and nothing else. `cwd` is where it starts, not a
    // wall: this leaves the writing unconfined, as the Codex adapter beside it does too — see
    // the reason written there. It matters most for a sub-task, whose
    // folder sits inside the folder of the work it belongs to — see `workspace.ts`. Said plainly
    // here because the alternative is somebody reading one folder per turn as a wall between them.
    permissionMode: 'bypassPermissions' as const,
    ...(resume === null ? {} : { resume }),
    ...(asked.model === undefined ? {} : { model: asked.model }),
    // Cast to the SDK's own type rather than to one of its members: what a person may pick came
    // from `offers`, which is this CLI's own answer, so the check that matters happened there.
    ...(asked.effort === undefined
      ? {}
      : { effort: asked.effort as NonNullable<Options['effort']> }),
  }
}

/**
 * Asks it to stop, and says whether it took the request.
 *
 * Interrupting leaves the conversation alive to be picked up again; killing the process would not.
 * Somebody who stops an agent means to redirect it, not to lose it.
 *
 * Only an accepted interrupt counts, because accepting is what rewrites the ending as cancelled.
 * Assumed rather than asked, an interrupt that was refused — an older CLI, a turn already over —
 * would put "you stopped it" in the record for a turn that ran to the end. That is the one thing
 * the transcript exists to make visible: asked to stop, and did not.
 */
async function accepted(running: ReturnType<typeof query> | undefined): Promise<boolean> {
  if (running === undefined) return false

  return running.interrupt().then(
    () => true,
    () => false,
  )
}

/** A turn that ended only because the session it was told to pick up is gone. */
function forgotten(told: Told): boolean {
  return told.told === 'ended' && told.why.why === 'failed' && looksForgotten(told.why.said)
}

/** What a turn somebody asked to stop ends as, however the CLI happened to report it. */
const STOPPED = { told: 'ended', why: { why: 'cancelled' } } as const

const asStopped = (told: Told): Told => (told.told === 'ended' ? STOPPED : told)

/**
 * Everything one query said, until it says the session it was told to pick up is gone.
 *
 * An interrupt does not always arrive as a throw: asked to stop part way through, the CLI
 * finishes the turn normally and reports an error result. Both paths mean the same thing, and
 * only we know which it was — we are the ones who asked.
 */
async function* everythingItSaid(
  asking: ReturnType<typeof query>,
  resume: string | null,
  /** Read each time, not once: somebody can ask it to stop while this is still running. */
  interrupted: () => boolean,
): AsyncGenerator<Told, boolean> {
  const translate = fold()

  for await (const message of asking) {
    const told = toldFrom(message, translate)
    // A session it no longer has is an answer, not an ending. Yielded, it would reach the
    // transcript as a failed turn before the fresh start that follows could correct it.
    if (resume !== null && told.some(forgotten)) return true

    yield* interrupted() ? told.map(asStopped) : told
  }

  return false
}

function talk(where: string, sofar: string | null, env: NodeJS.ProcessEnv): Talk {
  let running: ReturnType<typeof query> | undefined
  let interrupted = false

  /** Returns true when the agent could not pick up the session it was given. */
  async function* run(resume: string | null, asked: Asked): AsyncGenerator<Told, boolean> {
    const claude = await onPath(COMMAND, env)
    if (claude === undefined) {
      const said = 'Claude Code is no longer on this machine.'
      yield { told: 'ended', why: { why: 'failed', said } }
      return false
    }

    running = query({
      prompt: asked.text,
      options: settings({ where, claude, env }, resume, asked),
    })

    try {
      return yield* everythingItSaid(running, resume, () => interrupted)
    } catch (trouble) {
      if (interrupted) yield STOPPED
      else if (resume !== null && looksForgotten(plainly(trouble))) return true
      else yield { told: 'ended', why: { why: 'failed', said: plainly(trouble) } }
    } finally {
      running.close()
    }

    return false
  }

  return {
    say: async function* (asked: Asked): AsyncIterable<Told> {
      if (sofar !== null) {
        const forgotten = yield* run(sofar, asked)
        if (!forgotten) return
        yield { told: 'forgot' }
      }

      yield* run(null, asked)
    },

    stop: async () => {
      interrupted = await accepted(running)
    },
  }
}

export function claudeCode(env: NodeJS.ProcessEnv): Agent {
  return {
    command: COMMAND,
    offers: async (where) => offers(where, env),
    talk: (where, sofar) => talk(where, sofar, env),
  }
}
