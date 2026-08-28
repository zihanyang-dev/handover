/**
 * Driving Codex through its official app-server protocol and the binary already on this machine.
 *
 * The SDK's high-level turn stream omits command output deltas. App-server is the same official
 * Codex surface used by IDE clients, and its `item/commandExecution/outputDelta` notification is
 * the one place the bytes exist while the command is still running.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PIECE } from '@handover/universal'
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
import { openAppServer, type AppNotification, type AppServer } from './codex-app-server.ts'
import { onPath } from './on-path.ts'

const COMMAND = 'codex'
const ANSWER_WITHIN_MS = 10_000

type Item = Record<string, unknown> & { readonly id: string; readonly type: string }
type TurnIdentity = { readonly threadId: string; readonly turnId: string }
type ActiveTurn = {
  readonly server: AppServer
  threadId?: string
  turnId?: string
}
type RunControl = { active: ActiveTurn | undefined; interrupted: boolean }
type Running = {
  readonly where: string
  readonly env: NodeJS.ProcessEnv
  readonly control: RunControl
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

type ModelList = { readonly data: readonly Listed[] }
type ThreadAnswer = { readonly thread: { readonly id: string } }
type TurnAnswer = { readonly turn: { readonly id: string } }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function itemFrom(value: unknown): Item | undefined {
  const item = record(value)
  return typeof item?.['id'] === 'string' && typeof item['type'] === 'string'
    ? (item as Item)
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function texts(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

function did(what: Omit<Extract<Said, { said: 'did' }>, 'said'>): Said {
  return { said: 'did', ...what }
}

function starting(item: Item): Said[] {
  if (item.type !== 'commandExecution') return []
  return [
    {
      said: 'doing',
      callId: item.id,
      name: 'command_execution',
      verb: 'ran',
      arg: shorten(text(item['command'])),
    },
  ]
}

function changedPaths(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map(record)
    .filter((change) => change !== undefined)
    .map((change) => text(change['path']).split('/').at(-1) ?? '')
    .filter(Boolean)
    .join(', ')
}

function commandFinished(item: Item, streamed: string | undefined): Said {
  const complete = text(item['aggregatedOutput']) || streamed || ''
  return did({
    callId: item.id,
    name: 'command_execution',
    verb: 'ran',
    arg: shorten(text(item['command'])),
    ok: item['status'] === 'completed',
    excerpt: shorten(complete),
  })
}

function toolError(item: Item): string {
  return text(record(item['error'])?.['message'])
}

function speechFrom(item: Item): Said[] | undefined {
  if (item.type === 'userMessage' || item.type === 'hookPrompt') return []
  if (item.type === 'agentMessage') {
    const answer = text(item['text'])
    return answer === '' ? [] : [{ said: 'text', text: answer }]
  }
  if (item.type !== 'reasoning') return undefined
  const thinking = [...texts(item['summary']), ...texts(item['content'])].join('\n')
  return thinking === '' ? [] : [{ said: 'thinking', text: thinking }]
}

/** One completed app-server tool in the provider-neutral transcript vocabulary. */
function toolFrom(item: Item, streamedOutput: string | undefined): Said[] {
  if (item.type === 'commandExecution') return [commandFinished(item, streamedOutput)]
  if (item.type === 'fileChange') {
    return [
      did({
        callId: item.id,
        name: 'file_change',
        verb: 'edited',
        arg: changedPaths(item['changes']),
        ok: item['status'] === 'completed',
        excerpt: '',
      }),
    ]
  }
  if (item.type === 'mcpToolCall') {
    const name = `${text(item['server'])}/${text(item['tool'])}`
    const error = toolError(item)
    return [
      did({
        callId: item.id,
        name,
        verb: '',
        arg: '',
        ok: item['status'] === 'completed',
        excerpt: shorten(error),
      }),
    ]
  }
  if (item.type === 'webSearch') {
    return [
      did({
        callId: item.id,
        name: 'web_search',
        verb: 'searched',
        arg: shorten(text(item['query'])),
        excerpt: '',
      }),
    ]
  }

  // The tool set is open. Preserve an unfamiliar item by its provider name without guessing a
  // verb, verdict, parameters or output that this build does not know how to read.
  return [did({ callId: item.id, name: item.type, verb: '', arg: '', excerpt: '' })]
}

/** One completed app-server item in the provider-neutral transcript vocabulary. */
function finished(item: Item, streamedOutput: string | undefined): Said[] {
  return speechFrom(item) ?? toolFrom(item, streamedOutput)
}

function outputPieces(callId: string, at: number, output: string): Said[] {
  const pieces: Said[] = []
  for (let offset = 0; offset < output.length; offset += PIECE) {
    pieces.push({
      said: 'output',
      callId,
      at: at + offset,
      text: output.slice(offset, offset + PIECE),
    })
  }
  return pieces
}

function sameTurn(params: Record<string, unknown>, turn: TurnIdentity): boolean {
  const turnId = params['turnId'] ?? record(params['turn'])?.['id']
  return params['threadId'] === turn.threadId && turnId === turn.turnId
}

function turnEnding(params: Record<string, unknown>): Told {
  const turn = record(params['turn'])
  const status = turn?.['status']
  if (status === 'completed') return { told: 'ended', why: { why: 'done' } }
  if (status === 'interrupted') return { told: 'ended', why: { why: 'cancelled' } }
  const error = record(turn?.['error'])
  const said = text(error?.['message']) || 'Codex could not finish this turn.'
  return { told: 'ended', why: { why: 'failed', said } }
}

function startedFrom(params: Record<string, unknown>): Told[] {
  const item = itemFrom(params['item'])
  return item === undefined ? [] : starting(item).map((said) => ({ told: 'said', said }))
}

function outputFrom(params: Record<string, unknown>, outputs: Map<string, string>): Told[] {
  const callId = text(params['itemId'])
  const delta = text(params['delta'])
  if (callId === '' || delta === '') return []
  const before = outputs.get(callId) ?? ''
  outputs.set(callId, `${before}${delta}`)
  return outputPieces(callId, before.length, delta).map((said) => ({ told: 'said', said }))
}

function completedFrom(params: Record<string, unknown>, outputs: Map<string, string>): Told[] {
  const item = itemFrom(params['item'])
  if (item === undefined) return []
  const said = finished(item, outputs.get(item.id)).map(
    (one) => ({ told: 'said', said: one }) as const,
  )
  outputs.delete(item.id)
  return said
}

function troubleFrom(params: Record<string, unknown>): Told[] {
  const said = text(record(params['error'])?.['message']) || text(params['message'])
  return said === '' ? [] : [{ told: 'said', said: { said: 'trouble', text: said } }]
}

/** One app-server notification in Handover's words. Token deltas are deliberately not replayed. */
export function toldFromNotification(
  notification: AppNotification,
  turn: TurnIdentity,
  outputs: Map<string, string>,
): Told[] {
  const params = record(notification.params)
  if (params === undefined || !sameTurn(params, turn)) return []

  if (notification.method === 'item/started') return startedFrom(params)
  if (notification.method === 'item/commandExecution/outputDelta')
    return outputFrom(params, outputs)
  if (notification.method === 'item/completed') return completedFrom(params, outputs)
  if (notification.method === 'turn/completed') return [turnEnding(params)]
  if (notification.method === 'error') return troubleFrom(params)
  return []
}

function plainly(trouble: unknown): string {
  if (trouble instanceof Error && trouble.message.trim() !== '') return trouble.message
  const said = plain(trouble)
  return said === '' ? 'Codex stopped without saying why.' : said
}

function isForgotten(trouble: unknown): boolean {
  return /(?:no rollout found for thread|thread[^\n]*not found)/iu.test(plainly(trouble))
}

function threadParams(where: string, asked: Asked) {
  return {
    cwd: where,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    ...(asked.model === undefined ? {} : { model: asked.model }),
  }
}

function turnParams(threadId: string, where: string, asked: Asked) {
  return {
    threadId,
    input: [{ type: 'text', text: asked.text, text_elements: [] }],
    cwd: where,
    approvalPolicy: 'never',
    ...(asked.model === undefined ? {} : { model: asked.model }),
    ...(asked.effort === undefined ? {} : { effort: asked.effort }),
  }
}

async function threadFor(
  server: AppServer,
  resume: string | null,
  where: string,
  asked: Asked,
): Promise<string | undefined> {
  try {
    const answer =
      resume === null
        ? await server.request<ThreadAnswer>('thread/start', threadParams(where, asked))
        : await server.request<ThreadAnswer>('thread/resume', {
            threadId: resume,
            ...threadParams(where, asked),
          })
    return answer.thread.id
  } catch (trouble) {
    if (resume !== null && isForgotten(trouble)) return undefined
    throw trouble
  }
}

async function* watchTurn(server: AppServer, turn: TurnIdentity): AsyncGenerator<Told> {
  const outputs = new Map<string, string>()
  for (;;) {
    const notification = await server.next()
    if (notification === undefined) throw new Error('Codex app server stopped during the turn.')
    const told = toldFromNotification(notification, turn, outputs)
    yield* told
    if (told.some((one) => one.told === 'ended')) return
  }
}

async function* driveTurn(
  running: Running,
  resume: string | null,
  asked: Asked,
): AsyncGenerator<Told, boolean> {
  const { where, env, control } = running
  const binary = await onPath(COMMAND, env)
  if (binary === undefined) {
    yield { told: 'ended', why: { why: 'failed', said: 'Codex is no longer on this machine.' } }
    return false
  }

  let server: AppServer | undefined
  try {
    server = await openAppServer(binary, env)
    control.active = { server }
    const threadId = await threadFor(server, resume, where, asked)
    if (threadId === undefined) return true
    control.active.threadId = threadId
    yield { told: 'session', id: threadId }

    const started = await server.request<TurnAnswer>(
      'turn/start',
      turnParams(threadId, where, asked),
    )
    const turnId = started.turn.id
    control.active.turnId = turnId
    if (control.interrupted)
      await server.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
    yield* watchTurn(server, { threadId, turnId })
  } catch (trouble) {
    if (control.interrupted) yield { told: 'ended', why: { why: 'cancelled' } }
    else yield { told: 'ended', why: { why: 'failed', said: plainly(trouble) } }
  } finally {
    if (control.active?.server === server) control.active = undefined
    server?.close()
  }

  return false
}

type RunningProcess = { readonly pid: number; readonly parent: number }

function processRows(report: string): RunningProcess[] {
  return report
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length >= 2 && row.every(Number.isInteger))
    .map(([pid = 0, parent = 0]) => ({ pid, parent }))
}

function childrenOf(processes: readonly RunningProcess[], family: ReadonlySet<number>): number[] {
  return processes
    .filter((process) => family.has(process.parent) && !family.has(process.pid))
    .map((process) => process.pid)
}

function descendants(processes: readonly RunningProcess[], root: number): number[] {
  const family = new Set([root])
  const found: number[] = []
  for (;;) {
    const children = childrenOf(processes, family)
    if (children.length === 0) return found
    for (const child of children) family.add(child)
    found.push(...children)
  }
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // It finished between `ps` and the signal; that is already the requested outcome.
  }
}

async function terminateChildren(root: number): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid='])
    for (const pid of descendants(processRows(stdout), root).reverse()) terminate(pid)
  } catch {
    // The app-server interrupt still has a chance to stop a turn on a platform without this `ps`.
  }
}

function talk(where: string, sofar: string | null, env: NodeJS.ProcessEnv): Talk {
  const control: RunControl = { active: undefined, interrupted: false }
  const running = { where, env, control }

  return {
    say: async function* (asked: Asked): AsyncIterable<Told> {
      control.interrupted = false
      if (sofar !== null) {
        const forgotten = yield* driveTurn(running, sofar, asked)
        if (!forgotten) return
        yield { told: 'forgot' }
      }
      yield* driveTurn(running, null, asked)
    },
    stop: async () => {
      control.interrupted = true
      const current = control.active
      if (current?.threadId === undefined || current.turnId === undefined) return
      await terminateChildren(current.server.pid)
      await current.server
        .request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId })
        .catch(() => undefined)
    },
  }
}

async function within<Answer>(promise: Promise<Answer>, milliseconds: number): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Codex did not answer in time.'))
    }, milliseconds)
    timer.unref()
    void promise.then(
      (answer) => {
        clearTimeout(timer)
        resolve(answer)
      },
      (trouble: unknown) => {
        clearTimeout(timer)
        reject(trouble instanceof Error ? trouble : new Error(plainly(trouble)))
      },
    )
  })
}

async function offers(env: NodeJS.ProcessEnv): Promise<readonly Model[]> {
  const binary = await onPath(COMMAND, env)
  if (binary === undefined) return []

  let server: AppServer | undefined
  try {
    server = await openAppServer(binary, env)
    const listed = await within(server.request<ModelList>('model/list', {}), ANSWER_WITHIN_MS)
    return listed.data
      .filter((one) => one.hidden !== true)
      .map((one) => ({
        id: one.id,
        name: one.displayName,
        about: one.description,
        efforts: one.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        ...(one.defaultReasoningEffort === undefined
          ? {}
          : { defaultEffort: one.defaultReasoningEffort }),
        isDefault: one.isDefault === true,
      }))
  } catch {
    return []
  } finally {
    server?.close()
  }
}

export function codex(env: NodeJS.ProcessEnv): Agent {
  return {
    command: COMMAND,
    offers: async () => offers(env),
    talk: (where, sofar) => talk(where, sofar, env),
  }
}
