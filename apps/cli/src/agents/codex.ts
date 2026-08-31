/**
 * Driving Codex through its official app-server protocol and the binary already on this machine.
 *
 * The SDK's high-level turn stream omits command output deltas. App-server is the same official
 * Codex surface used by IDE clients, and its `item/commandExecution/outputDelta` notification is
 * the one place the bytes exist while the command is still running.
 */

import { textPieces } from '@handover/universal'
import { terminateDescendants } from '../process-tree.ts'
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
import {
  asRecord,
  openAppServer,
  type AppNotification,
  type AppServer,
} from './codex-app-server.ts'
import { onPath } from './on-path.ts'

const COMMAND = 'codex'
const ANSWER_WITHIN_MS = 10_000

type Item = Record<string, unknown> & { readonly id: string; readonly type: string }
type TurnIdentity = { readonly threadId: string; readonly turnId: string }
export type OutputProgress = {
  readonly at: number
  readonly excerpt: string
  readonly prefixMissing: boolean
}
type ActiveTurn =
  | { readonly phase: 'starting'; readonly server: AppServer }
  | {
      readonly phase: 'running'
      readonly server: AppServer
      readonly threadId: string
      readonly turnId: string
    }
type RunControl = { active: ActiveTurn | undefined; interrupted: boolean }
type TurnRun = 'done' | 'forgotten'
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

function threadAnswer(value: unknown): ThreadAnswer {
  const id = text(asRecord(asRecord(value)?.['thread'])?.['id'])
  if (id === '') throw new Error('Codex returned a thread without an id.')
  return { thread: { id } }
}

function turnAnswer(value: unknown): TurnAnswer {
  const id = text(asRecord(asRecord(value)?.['turn'])?.['id'])
  if (id === '') throw new Error('Codex returned a turn without an id.')
  return { turn: { id } }
}

function listedModel(value: unknown): Listed | undefined {
  const model = asRecord(value)
  const id = text(model?.['id'])
  if (model === undefined || id === '') return undefined

  const efforts = Array.isArray(model['supportedReasoningEfforts'])
    ? model['supportedReasoningEfforts']
        .map(asRecord)
        .map((effort) => text(effort?.['reasoningEffort']))
        .filter((effort) => effort !== '')
        .map((reasoningEffort) => ({ reasoningEffort }))
    : []

  return {
    id,
    displayName: text(model['displayName']) || id,
    description: text(model['description']),
    supportedReasoningEfforts: efforts,
    ...(typeof model['defaultReasoningEffort'] === 'string'
      ? { defaultReasoningEffort: model['defaultReasoningEffort'] }
      : {}),
    ...(typeof model['isDefault'] === 'boolean' ? { isDefault: model['isDefault'] } : {}),
    ...(typeof model['hidden'] === 'boolean' ? { hidden: model['hidden'] } : {}),
  }
}

function modelList(value: unknown): ModelList {
  const data = asRecord(value)?.['data']
  if (!Array.isArray(data)) throw new Error('Codex returned no model list.')
  return { data: data.map(listedModel).filter((model) => model !== undefined) }
}

function itemFrom(value: unknown): Item | undefined {
  const item = asRecord(value)
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
    .map(asRecord)
    .filter((change) => change !== undefined)
    .map((change) => text(change['path']).split('/').at(-1) ?? '')
    .filter(Boolean)
    .join(', ')
}

function commandFinished(item: Item, streamed: OutputProgress | undefined): Said {
  const complete = text(item['aggregatedOutput']) || streamed?.excerpt || ''
  return did({
    callId: item.id,
    name: 'command_execution',
    verb: 'ran',
    arg: shorten(text(item['command'])),
    ok: item['status'] === 'completed',
    excerpt: shorten(complete),
    ...(streamed?.prefixMissing === true ? { truncated: true } : {}),
  })
}

function toolError(item: Item): string {
  return text(asRecord(item['error'])?.['message'])
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
function toolFrom(item: Item, streamedOutput: OutputProgress | undefined): Said[] {
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
function finished(item: Item, streamedOutput: OutputProgress | undefined): Said[] {
  return speechFrom(item) ?? toolFrom(item, streamedOutput)
}

function outputPieces(callId: string, at: number, output: string, prefixMissing = false): Said[] {
  return textPieces(output, at).map((piece, index) => ({
    said: 'output',
    callId,
    at: piece.at,
    text: piece.text,
    ...(prefixMissing && index === 0 ? { truncated: true } : {}),
  }))
}

function sameTurn(params: Record<string, unknown>, turn: TurnIdentity): boolean {
  const turnId = params['turnId'] ?? asRecord(params['turn'])?.['id']
  return params['threadId'] === turn.threadId && turnId === turn.turnId
}

function turnEnding(params: Record<string, unknown>): Told {
  const turn = asRecord(params['turn'])
  const status = turn?.['status']
  if (status === 'completed') return { told: 'ended', why: { why: 'done' } }
  if (status === 'interrupted') return { told: 'ended', why: { why: 'cancelled' } }
  const error = asRecord(turn?.['error'])
  const said = text(error?.['message']) || 'Codex could not finish this turn.'
  return { told: 'ended', why: { why: 'failed', said } }
}

function startedFrom(
  params: Record<string, unknown>,
  outputs: Map<string, OutputProgress>,
): Told[] {
  const item = itemFrom(params['item'])
  if (item === undefined) return []

  const said = starting(item)
  if (item.type !== 'commandExecution') return said.map((one) => ({ told: 'said', said: one }))

  const initialOutput = text(item['aggregatedOutput'])
  // App-server 0.148 can start listening after a fast command has already printed its first
  // chunk. An empty start therefore cannot prove a known offset zero; the UI says so explicitly.
  outputs.set(item.id, {
    at: initialOutput.length,
    excerpt: shorten(initialOutput),
    prefixMissing: initialOutput === '',
  })
  if (initialOutput !== '') said.push(...outputPieces(item.id, 0, initialOutput))
  return said.map((one) => ({ told: 'said', said: one }))
}

function outputFrom(params: Record<string, unknown>, outputs: Map<string, OutputProgress>): Told[] {
  const callId = text(params['itemId'])
  const delta = text(params['delta'])
  if (callId === '' || delta === '') return []

  const before = outputs.get(callId) ?? { at: 0, excerpt: '', prefixMissing: true }
  outputs.set(callId, {
    at: before.at + delta.length,
    excerpt: shorten(`${before.excerpt}${delta}`),
    prefixMissing: before.prefixMissing,
  })

  return outputPieces(callId, before.at, delta, before.prefixMissing && before.at === 0).map(
    (said) => ({
      told: 'said',
      said,
    }),
  )
}

function completedFrom(
  params: Record<string, unknown>,
  outputs: Map<string, OutputProgress>,
): Told[] {
  const item = itemFrom(params['item'])
  if (item === undefined) return []

  const said = finished(item, outputs.get(item.id)).map(
    (one) => ({ told: 'said', said: one }) as const,
  )
  outputs.delete(item.id)
  return said
}

function troubleFrom(params: Record<string, unknown>): Told[] {
  const said = text(asRecord(params['error'])?.['message']) || text(params['message'])
  return said === '' ? [] : [{ told: 'said', said: { said: 'trouble', text: said } }]
}

/** One app-server notification in Handover's words. Token deltas are deliberately not replayed. */
export function toldFromNotification(
  notification: AppNotification,
  turn: TurnIdentity,
  outputs: Map<string, OutputProgress>,
): Told[] {
  const params = asRecord(notification.params)
  if (params === undefined || !sameTurn(params, turn)) return []

  if (notification.method === 'item/started') return startedFrom(params, outputs)
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

/** App-server reports a removed thread only in error prose; its protocol has no error code. */
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
    if (resume === null) {
      const answer = await server.request('thread/start', threadParams(where, asked))
      return threadAnswer(answer).thread.id
    }

    const answer = await server.request('thread/resume', {
      threadId: resume,
      ...threadParams(where, asked),
    })
    return threadAnswer(answer).thread.id
  } catch (trouble) {
    if (resume !== null && isForgotten(trouble)) return undefined
    throw trouble
  }
}

async function* watchTurn(server: AppServer, turn: TurnIdentity): AsyncGenerator<Told> {
  const outputs = new Map<string, OutputProgress>()
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
): AsyncGenerator<Told, TurnRun> {
  const { where, env, control } = running
  const binary = await onPath(COMMAND, env)
  if (binary === undefined) {
    yield { told: 'ended', why: { why: 'failed', said: 'Codex is no longer on this machine.' } }
    return 'done'
  }

  let server: AppServer | undefined
  try {
    server = await openAppServer(binary, env)
    control.active = { phase: 'starting', server }
    const threadId = await threadFor(server, resume, where, asked)
    if (threadId === undefined) return 'forgotten'
    yield { told: 'session', id: threadId }

    const started = await server.request('turn/start', turnParams(threadId, where, asked))
    const turnId = turnAnswer(started).turn.id
    control.active = { phase: 'running', server, threadId, turnId }
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

  return 'done'
}

function talk(where: string, sofar: string | null, env: NodeJS.ProcessEnv): Talk {
  const control: RunControl = { active: undefined, interrupted: false }
  const running = { where, env, control }

  return {
    say: async function* (asked: Asked): AsyncIterable<Told> {
      control.interrupted = false
      if (sofar !== null) {
        const first = yield* driveTurn(running, sofar, asked)
        if (first === 'done') return
        yield { told: 'forgot' }
      }
      yield* driveTurn(running, null, asked)
    },
    stop: async () => {
      control.interrupted = true
      const current = control.active
      if (current === undefined) return
      // `turn/interrupt` stops the turn but can leave its shell descendants alive; stop those first
      // while the app-server process still gives us the root of the process tree.
      await terminateDescendants(current.server.pid)
      if (current.phase !== 'running') return

      // Whether the interrupt lands is not what stops the turn — the descendants are already
      // gone above, and `control.interrupted` is what turns the failure that follows into
      // `cancelled` rather than `failed`. This is the polite half, and an app-server that will
      // not take it has nothing left to be asked.
      await current.server
        .request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId })
        .catch(() => undefined)
    },
  }
}

async function answerWithin<Answer>(
  promise: Promise<Answer>,
  milliseconds: number,
): Promise<Answer> {
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
    const answer = await answerWithin(server.request('model/list', {}), ANSWER_WITHIN_MS)
    const listed = modelList(answer)
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
