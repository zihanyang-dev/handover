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
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent, Asked, Model, Said, Talk, Told } from './agent.ts'
import { plain, shorten } from './agent.ts'
import { onPath } from './on-path.ts'

/** The binary this drives. Found on the PATH captured when the machine was connected. */
const COMMAND = 'codex'

/** The flag the SDK starts a turn with, and how a turn is told apart from anything else Codex. */
const JSON_TURN = '--experimental-json'

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

/** One thing it did. `ok` is left off by callers that have no verdict to report — most tools. */
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
        // The whole of it as well, for whoever is watching. It is not written down — see
        // `prd.md` 03 ⑦, where the full output is there while it runs and a first paragraph after.
        output: item.aggregated_output,
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
 * The one thing Codex refuses that is not a fault: it no longer has that thread.
 *
 * Its own words, measured against the real CLI — `thread/resume failed: no rollout found for
 * thread id …`. Recognised here because only this adapter knows what its agent's refusal reads
 * like, and calling it a failure would send somebody looking for a fault that is not there.
 */
function isForgotten(trouble: unknown): boolean {
  return /no rollout found for thread/iu.test(plainly(trouble))
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

/**
 * The turns this program has Codex running right now.
 *
 * The SDK spawns Codex as a child of this process and keeps the handle to itself, so the only way
 * to reach that process is to go and look for it. Matched on the binary and on the flag the SDK
 * starts it with: an `app-server` asked what models exist is a child of ours too, and stopping a
 * turn must not stop that.
 */
async function turnsRunning(binary: string): Promise<readonly number[]> {
  const listed = await runningProcesses()

  return listed.flatMap((line) => {
    const [, pid, parent, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line) ?? []
    if (pid === undefined || parent !== String(process.pid)) return []
    if (command === undefined || !command.includes(binary) || !command.includes(JSON_TURN)) {
      return []
    }

    return [Number(pid)]
  })
}

/** What is running on this machine, in the one form both macOS and Linux answer in. */
async function runningProcesses(): Promise<readonly string[]> {
  return promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid=,args=']).then(
    ({ stdout }) => stdout.split('\n'),
    () => {
      // No `ps` on this machine, so a turn cannot be found by looking. Stopping still aborts the
      // stream below, which is what this did before it could look at all.
      return []
    },
  )
}

/**
 * The two halves of stopping a turn, which are not the same half.
 *
 * `asked` is whether somebody asked — the only thing that decides whether an ending is written
 * down as cancelled. `signal` is the SDK's, and aborting it kills Codex outright; it is the
 * fallback for when there is no process to interrupt politely.
 */
type Stopping = {
  readonly asked: () => boolean
  readonly signal: AbortSignal
}

/**
 * How one turn is run.
 *
 * Nothing here is a preference: nobody is standing at this machine to answer a prompt, so
 * anything that stopped to ask would hang there until the turn was given up on.
 */
function howToRun(where: string, asked: Asked, env: NodeJS.ProcessEnv) {
  return {
    workingDirectory: where,
    // Handed on rather than left to be inherited, because one variable in it says which
    // conversation this turn belongs to — which is how `handover task` knows what it is talking
    // about without anybody typing an id. Codex does not inherit at all unless told to.
    env: onlyStrings(env),
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
    ...(asked.model === undefined ? {} : { model: asked.model }),
    // Cast to the SDK's own type rather than to one of its members: what a person may pick came
    // from `offers`, which is the CLI's own answer, so the check happened there.
    ...(asked.effort === undefined
      ? {}
      : { modelReasoningEffort: asked.effort as ModelReasoningEffort }),
  }
}

/**
 * Interrupts the turns this program has Codex running, and says whether it found any.
 *
 * SIGINT is what Ctrl-C sends, and it is the one Codex passes on to the command it is running.
 * This is measured rather than assumed: killed with SIGTERM instead — which is what aborting the
 * SDK's stream does — Codex dies without stopping what it started, and a minute after one such
 * turn had been written down as cancelled, the shell loop it began was still writing files.
 */
async function interrupt(binary: string): Promise<number> {
  const turns = await turnsRunning(binary)

  for (const pid of turns) {
    try {
      process.kill(pid, 'SIGINT')
    } catch {
      // It ended between being listed and being asked to stop, which is what was wanted.
    }
  }

  return turns.length
}

/**
 * One turn, picked up where the last one left off when there is one to pick up.
 *
 * A thread Codex no longer has is not a failure and not the end of the turn: it starts over from
 * nothing and says so first, because an answer written by an agent that remembers nothing is not
 * the answer somebody was expecting to a conversation they were in the middle of.
 */
async function* whatItSays(
  codex: Codex,
  turn: { readonly options: ReturnType<typeof howToRun>; readonly asked: Asked },
  sofar: string | null,
  stopping: Stopping,
): AsyncGenerator<Told> {
  const { options, asked } = turn

  if (sofar !== null) {
    const forgotten = yield* stream(codex.resumeThread(sofar, options), asked, stopping, true)
    if (!forgotten) return

    yield { told: 'forgot' }
  }

  yield* stream(codex.startThread(options), asked, stopping)
}

function talk(where: string, sofar: string | null, env: NodeJS.ProcessEnv): Talk {
  const aborting = new AbortController()
  let wasAsked = false
  const stopping: Stopping = { asked: () => wasAsked, signal: aborting.signal }
  /**
   * The binary while a turn is running, and nothing once it is over.
   *
   * What `stop` needs to go and find the process — and, just as much, what tells it there is
   * nothing to find. Cleared when the turn ends, because by then any Codex running is somebody
   * else's turn and interrupting it would stop work nobody asked to stop.
   */
  let running: string | undefined

  return {
    say: async function* (asked: Asked): AsyncIterable<Told> {
      const binary = await onPath(COMMAND, env)
      if (binary === undefined) {
        yield { told: 'ended', why: { why: 'failed', said: 'Codex is no longer on this machine.' } }
        return
      }

      const codex = new Codex({ codexPathOverride: binary })
      const options = howToRun(where, asked, env)
      running = binary

      try {
        yield* whatItSays(codex, { options, asked }, sofar, stopping)
      } finally {
        running = undefined
      }
    },

    /**
     * Asks the turn to stop, and interrupts Codex to make it so.
     *
     * Aborting is the fallback, not the first move, because aborting is a SIGTERM — see
     * {@link interrupt}. It is right in exactly one case: there was no process to interrupt,
     * which is a turn stopped before it had begun.
     */
    stop: async () => {
      wasAsked = true
      const interrupted = running === undefined ? 0 : await interrupt(running)
      if (interrupted === 0) aborting.abort()
    },
  }
}

export async function* stream(
  thread: Pick<ReturnType<Codex['startThread']>, 'runStreamed'>,
  asked: Asked,
  stopping: Stopping,
  /** Whether a thread Codex no longer has is an answer rather than a fault. */
  resuming = false,
): AsyncGenerator<Told, boolean> {
  // A turn ends once. Codex reports a failed turn as an event and then throws on the way out, so
  // without this the same failure is announced twice — which today is invisible only because the
  // caller stops reading at the first ending. A contract that holds because nobody looked is not
  // one this file is keeping.
  let ended = false

  try {
    const turn = await thread.runStreamed(asked.text, { signal: stopping.signal })
    for await (const event of turn.events) {
      const told = fromEvent(event)
      ended ||= told.some((one) => one.told === 'ended')
      yield* told
    }
  } catch (trouble) {
    if (ended) return false

    // Never `instanceof`: what is thrown here is minified, and its `name` is not always
    // `AbortError` — and an interrupted Codex does not throw an abort at all, it exits on a
    // signal. We are the ones who asked it to stop, so we are the ones who know.
    if (stopping.asked()) yield { told: 'ended', why: { why: 'cancelled' } }
    else if (resuming && isForgotten(trouble)) return true
    else yield { told: 'ended', why: { why: 'failed', said: plainly(trouble) } }
  }

  return false
}

/**
 * What Codex lets a person choose.
 *
 * Asked through `codex app-server` rather than the SDK, which has no way to ask: the SDK takes a
 * model name but will not say which names there are. The CLI answers over its own JSON-RPC and is
 * shut down again, without ever starting a thread.
 */
async function offers(env: NodeJS.ProcessEnv): Promise<readonly Model[]> {
  const binary = await onPath(COMMAND, env)
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
    command: COMMAND,
    offers: async () => offers(env),
    talk: (where, sofar) => talk(where, sofar, env),
  }
}

/** The SDK takes only set variables; an unset one and one set to nothing are the same thing. */
function onlyStrings(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
  )
}
