import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type AppNotification = {
  readonly method: string
  readonly params: unknown
}

export type AppServer = {
  readonly pid: number
  readonly request: <Answer>(method: string, params: unknown) => Promise<Answer>
  readonly next: () => Promise<AppNotification | undefined>
  readonly close: () => void
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
}

type WaitingNotification = (notification: AppNotification | undefined) => void
type JsonRecord = Record<string, unknown>

type Transport = {
  readonly child: ChildProcessWithoutNullStreams
  readonly pending: Map<number, PendingRequest>
  readonly notifications: AppNotification[]
  readonly waiting: WaitingNotification[]
  requestId: number
  rest: string
  closed: boolean
  stderr: string
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

function message(line: string): JsonRecord | undefined {
  try {
    return record(JSON.parse(line))
  } catch {
    return undefined
  }
}

function errorFrom(value: unknown): Error {
  const error = record(value)
  return new Error(
    typeof error?.['message'] === 'string' ? error['message'] : 'Codex refused a request.',
  )
}

function finish(transport: Transport, reason?: Error): void {
  if (transport.closed) return
  transport.closed = true
  const failure = reason ?? new Error(transport.stderr.trim() || 'Codex app server stopped.')
  for (const request of transport.pending.values()) request.reject(failure)
  transport.pending.clear()
  for (const notify of transport.waiting.splice(0)) notify(undefined)
}

function receive(transport: Transport, value: JsonRecord): void {
  if (typeof value['id'] === 'number') {
    const request = transport.pending.get(value['id'])
    if (request === undefined) return
    transport.pending.delete(value['id'])
    if (value['error'] === undefined) request.resolve(value['result'])
    else request.reject(errorFrom(value['error']))
    return
  }

  if (typeof value['method'] !== 'string') return
  const notification = { method: value['method'], params: value['params'] }
  const notify = transport.waiting.shift()
  if (notify === undefined) transport.notifications.push(notification)
  else notify(notification)
}

function attach(transport: Transport): void {
  const { child } = transport
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const lines = `${transport.rest}${chunk}`.split('\n')
    transport.rest = lines.pop() ?? ''
    for (const line of lines) {
      const value = message(line)
      if (value !== undefined) receive(transport, value)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    transport.stderr = `${transport.stderr}${chunk}`.slice(-4000)
  })
  child.on('error', (trouble) => {
    finish(transport, trouble)
  })
  child.on('exit', (code) => {
    finish(
      transport,
      new Error(transport.stderr.trim() || `Codex app server exited (${String(code)}).`),
    )
  })
}

function asServer(transport: Transport): AppServer {
  const pid = transport.child.pid
  if (pid === undefined) throw new Error('Codex app server did not start.')
  return {
    pid,
    request: async <Answer>(method: string, params: unknown): Promise<Answer> => {
      if (transport.closed) throw new Error('Codex app server is closed.')
      transport.requestId += 1
      const id = transport.requestId
      const answer = new Promise<unknown>((resolve, reject) => {
        transport.pending.set(id, { resolve, reject })
      })
      transport.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return (await answer) as Answer
    },
    next: async () => {
      const next = transport.notifications.shift()
      if (next !== undefined) return next
      if (transport.closed) return undefined
      return new Promise((resolve) => {
        transport.waiting.push(resolve)
      })
    },
    close: () => {
      transport.child.kill()
      finish(transport)
    },
  }
}

/** Opens one official Codex app-server process and completes its initialization handshake. */
export async function openAppServer(binary: string, env: NodeJS.ProcessEnv): Promise<AppServer> {
  const child = spawn(binary, ['app-server', '-c', 'shell_environment_policy.inherit=all'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const transport: Transport = {
    child,
    pending: new Map(),
    notifications: [],
    waiting: [],
    requestId: 0,
    rest: '',
    closed: false,
    stderr: '',
  }
  attach(transport)
  const server = asServer(transport)
  await server.request('initialize', { clientInfo: { name: 'handover', version: '0' } })
  return server
}
