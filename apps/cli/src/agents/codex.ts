/**
 * Driving Codex.
 *
 * Through OpenAI's own SDK, pointed at the copy already on this machine, for the same reason as
 * Claude Code: the login is in that CLI.
 *
 * Codex names the same things differently in its live events and on the wire underneath.
 * Reconciling them is this file's job and nothing above it ever finds out.
 */

import { Codex } from '@openai/codex-sdk'
import type { ModelReasoningEffort, ThreadEvent, ThreadItem } from '@openai/codex-sdk'
import { spawn } from 'node:child_process'
import type { Agent, Asked, Model, Said, Talk, Told } from './agent.ts'
import { plain, shorten } from './agent.ts'
import { onPath } from './on-path.ts'

/**
 * An item that has only just started.
 *
 * Almost nothing is worth saying twice. A command is the exception: it can run for minutes, and
 * somebody watching wants to see it go rather than wait for it to come back.
 */
function starting(item: ThreadItem): Said[] {
  if (item.type !== 'command_execution') return []

  return [{ said: 'doing', name: item.type, verb: 'ran', arg: shorten(item.command) }]
}

/** One thing it did. `excerpt` and `ok` default to nothing: most tools report neither. */
function did(what: Omit<Extract<Said, { said: 'did' }>, 'said'>): Said {
  return { said: 'did', ...what }
}

/**
 * An item that is over, in our words.
 *
 * Three of Codex's items carry something worth unpacking; the rest are tools, and tools are open.
 * A branch per tool would be this file keeping a list of what Codex can do — wrong the day Codex
 * learns something new, and wrong in the quiet way, by showing nothing for it.
 *
 * So anything not unpacked here still arrives as a line with the name Codex gave it. That is the
 * same bargain the other adapter makes for the tools it does not recognise.
 */
function finished(item: ThreadItem): Said[] {
  if (item.type === 'agent_message') return [{ said: 'text', text: item.text }]
  if (item.type === 'reasoning') return [{ said: 'thinking', text: item.text }]
  if (item.type === 'error') return [{ said: 'trouble', text: item.message }]

  if (item.type === 'command_execution') {
    return [
      did({
        name: item.type,
        verb: 'ran',
        arg: shorten(item.command),
        ok: item.exit_code === 0,
        excerpt: shorten(item.aggregated_output),
      }),
    ]
  }

  if (item.type === 'file_change') {
    const arg = item.changes.map(named).join(', ')
    return [
      did({ name: item.type, verb: 'edited', arg, ok: item.status === 'completed', excerpt: '' }),
    ]
  }

  if (item.type === 'mcp_tool_call') {
    const name = `${item.server}/${item.tool}`
    const excerpt = shorten(plain(item.error?.message))
    return [did({ name, verb: '', arg: '', ok: item.status === 'completed', excerpt })]
  }

  return [did({ name: item.type, verb: '', arg: '', excerpt: '' })]
}

function named(change: { readonly path: string }): string {
  return change.path.split('/').slice(-1)[0] ?? change.path
}

function fromEvent(event: ThreadEvent): Told[] {
  switch (event.type) {
    case 'thread.started':
      return [{ told: 'session', id: event.thread_id }]
    case 'item.started':
      return starting(event.item).map((said) => ({ told: 'said', said }))
    case 'item.updated':
      return []
    case 'item.completed':
      return finished(event.item).map((said) => ({ told: 'said', said }))
    case 'turn.completed':
      return [{ told: 'ended', why: { why: 'done' } }]
    case 'turn.failed':
      return [{ told: 'ended', why: { why: 'failed', said: plainly(event.error) } }]
    // Trouble it reported and carried on from. Not an ending: `turn.failed` is what says a turn
    // is over, and ending it twice would close a turn that is still running.
    case 'error':
      return [{ told: 'said', said: { said: 'trouble', text: event.message } }]
    case 'turn.started':
      return []
    default:
      return unheardOfEvent(event)
  }
}

/**
 * An event from a newer Codex than this build was written against.
 *
 * Typed `never`, so adding one to the SDK's union is a compile error here rather than a surprise
 * on somebody's machine. Events are worth that and items are not: an event is the shape of a
 * turn, which this file has to understand, while an item is a tool, and tools are open.
 */
function unheardOfEvent(_event: never): Told[] {
  return []
}

/**
 * What to show a person when a turn ends badly.
 *
 * Codex throws provider errors verbatim, so what arrives here is often a JSON body. A person
 * reading a page is owed the sentence inside it, not the envelope it came in.
 */
export function plainly(trouble: unknown): string {
  const said = plain((trouble as { message?: unknown } | undefined)?.message).trim()
  if (!said.startsWith('{')) return said === '' ? 'Codex stopped without saying why.' : said

  try {
    const body = JSON.parse(said) as { error?: { message?: string } }
    return body.error?.message ?? said
  } catch {
    // Not the shape we hoped for; the raw text is still better than nothing.
    return said
  }
}

function talk(where: string, sofar: string | null, env: NodeJS.ProcessEnv): Talk {
  const stopping = new AbortController()

  return {
    say: async function* (asked: Asked): AsyncIterable<Told> {
      const binary = await onPath('codex', env)
      if (binary === undefined) {
        yield { told: 'ended', why: { why: 'failed', said: 'Codex is no longer on this machine.' } }
        return
      }

      const codex = new Codex({ codexPathOverride: binary })
      const options = {
        workingDirectory: where,
        skipGitRepoCheck: true,
        // Nobody is standing at this machine to answer a prompt, so anything that asks would hang
        // there until the turn was given up on.
        sandboxMode: 'workspace-write' as const,
        approvalPolicy: 'never' as const,
        ...(asked.model === undefined ? {} : { model: asked.model }),
        // Cast to the SDK's own type rather than to one of its members: what a person may pick
        // came from `offers`, which is the CLI's own answer, so the check happened there.
        ...(asked.effort === undefined
          ? {}
          : { modelReasoningEffort: asked.effort as ModelReasoningEffort }),
      }

      const thread =
        sofar === null ? codex.startThread(options) : codex.resumeThread(sofar, options)
      yield* stream(thread, asked, stopping.signal)
    },

    // Codex offers no gentler interruption than this, and it does not need one: the thread is
    // saved on its side, so the next turn picks the conversation up where this one was stopped.
    stop: async () => {
      stopping.abort()
    },
  }
}

async function* stream(
  thread: ReturnType<Codex['startThread']>,
  asked: Asked,
  until: AbortSignal,
): AsyncIterable<Told> {
  try {
    const turn = await thread.runStreamed(asked.text, { signal: until })
    for await (const event of turn.events) yield* fromEvent(event)
  } catch (trouble) {
    // Never `instanceof`: what is thrown here is minified, and its `name` is not always
    // `AbortError`. We are the ones who asked it to stop, so we are the ones who know.
    if (until.aborted) yield { told: 'ended', why: { why: 'cancelled' } }
    else yield { told: 'ended', why: { why: 'failed', said: plainly(trouble) } }
  }
}

/**
 * What Codex lets a person choose.
 *
 * Asked through `codex app-server` rather than the SDK, which has no way to ask: the SDK takes a
 * model name but will not say which names there are. The CLI answers over its own JSON-RPC and is
 * shut down again, without ever starting a thread.
 */
async function offers(env: NodeJS.ProcessEnv): Promise<readonly Model[]> {
  const binary = await onPath('codex', env)
  if (binary === undefined) return []

  const listed = await listModels(binary, env)

  return listed
    .filter((one) => one.hidden !== true)
    .map((one) => ({
      id: one.id,
      name: one.displayName,
      about: one.description,
      efforts: one.supportedReasoningEfforts.map((each) => each.reasoningEffort),
      ...(one.defaultReasoningEffort === undefined
        ? {}
        : { defaultEffort: one.defaultReasoningEffort }),
      isDefault: one.isDefault === true,
    }))
}

type Listed = {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly supportedReasoningEfforts: readonly { readonly reasoningEffort: string }[]
  readonly defaultReasoningEffort?: string
  readonly isDefault?: boolean
  readonly hidden?: boolean
}

const HELLO = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'handover', version: '0' } },
}

const WHICH_MODELS = { jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }

/**
 * The one reply we are waiting for, out of a stream that also carries unrelated notifications.
 *
 * A chunk is whatever the pipe happened to hand over, so it can end mid-line. What is left over
 * is kept for the next one — read line by line without that, a reply that arrives in two pieces is
 * two things that will not parse, and the list comes back empty ten seconds later.
 */
export function reader(): (chunk: string) => readonly (readonly Listed[])[] {
  let rest = ''

  return (chunk) => {
    const lines = `${rest}${chunk}`.split('\n')
    rest = lines.pop() ?? ''

    return lines.map(parsedReply).filter((reply) => reply !== undefined)
  }
}

/** Long enough for a cold binary, short enough that a page waiting on it does not feel stuck. */
const ANSWER_WITHIN_MS = 10_000

async function listModels(binary: string, env: NodeJS.ProcessEnv): Promise<readonly Listed[]> {
  return new Promise((settle) => {
    const server = spawn(binary, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    let over = false

    const done = (models: readonly Listed[]) => {
      if (over) return
      over = true
      server.kill()
      settle(models)
    }

    // Nobody can pick a model they were never offered, so a CLI that will not answer means no
    // control on the page rather than a turn that cannot be taken. Unreferenced so that waiting
    // for an answer never keeps this program alive on its own.
    setTimeout(() => {
      done([])
    }, ANSWER_WITHIN_MS).unref()

    server.on('error', () => {
      done([])
    })
    const read = reader()
    server.stdout.setEncoding('utf8')
    server.stdout.on('data', (chunk: string) => {
      for (const models of read(chunk)) done(models)
    })

    server.stdin.write(`${JSON.stringify(HELLO)}\n${JSON.stringify(WHICH_MODELS)}\n`)
  })
}

function parsedReply(line: string): readonly Listed[] | undefined {
  if (line.trim() === '') return undefined
  try {
    const message = JSON.parse(line) as { id?: number; result?: { data?: Listed[] } }
    if (message.id !== WHICH_MODELS.id) return undefined

    return message.result?.data ?? []
  } catch {
    // Not JSON at all. A line that was only half here never reaches this: it is held back.
    return undefined
  }
}

export function codex(env: NodeJS.ProcessEnv): Agent {
  return {
    offers: async () => offers(env),
    talk: (where, sofar) => talk(where, sofar, env),
  }
}
