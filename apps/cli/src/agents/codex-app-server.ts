import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type AppNotification = {
  readonly method: string
  readonly params: unknown
}

export type AppServer = {
  readonly pid: number
  readonly request: (method: string, params: unknown) => Promise<unknown>
  readonly next: () => Promise<AppNotification | undefined>
  readonly close: () => void
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
}

type WaitingNotification = (notification: AppNotification | undefined) => void
export type JsonRecord = Record<string, unknown>

const STDERR_LIMIT = 4000
const MAX_PENDING_NOTIFICATIONS = 256
const RESUME_PENDING_NOTIFICATIONS = MAX_PENDING_NOTIFICATIONS / 2

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

function jsonRecord(line: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}

function errorFrom(value: unknown): Error {
  const error = asRecord(value)
  const message = typeof error?.['message'] === 'string' ? error['message'] : undefined
  return new Error(message ?? 'Codex refused a request.')
}

/** One app-server process and every request, notification, and listener that belongs to it. */
class AppServerProcess implements AppServer {
  readonly pid: number
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notifications: AppNotification[] = []
  private readonly waiting: WaitingNotification[] = []
  private requestId = 0
  private rest = ''
  private stderr = ''
  private closed = false
  private stdoutPaused = false
  private readonly child: ChildProcessWithoutNullStreams

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    const pid = child.pid
    if (pid === undefined) throw new Error('Codex app server did not start.')
    this.pid = pid
    this.attach()
  }

  readonly request = async (method: string, params: unknown): Promise<unknown> => {
    if (this.closed) throw new Error('Codex app server is closed.')

    this.requestId += 1
    const id = this.requestId
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)

    return answer
  }

  readonly next = async (): Promise<AppNotification | undefined> => {
    const notification = this.notifications.shift()
    if (notification !== undefined) {
      this.resumeNotifications()
      return notification
    }
    if (this.closed) return undefined

    return new Promise((resolve) => {
      this.waiting.push(resolve)
    })
  }

  readonly close = (): void => {
    this.child.kill()
    this.finish()
  }

  private readonly receive = (value: JsonRecord): void => {
    if (typeof value['id'] === 'number') {
      const request = this.pending.get(value['id'])
      if (request === undefined) return

      this.pending.delete(value['id'])
      if (value['error'] === undefined) request.resolve(value['result'])
      else request.reject(errorFrom(value['error']))
      return
    }

    if (typeof value['method'] !== 'string') return
    const notification = { method: value['method'], params: value['params'] }
    const waiting = this.waiting.shift()
    if (waiting !== undefined) {
      waiting(notification)
      return
    }

    this.notifications.push(notification)
    if (this.notifications.length >= MAX_PENDING_NOTIFICATIONS && !this.stdoutPaused) {
      this.child.stdout.pause()
      this.stdoutPaused = true
    }
  }

  private resumeNotifications(): void {
    if (!this.stdoutPaused || this.notifications.length > RESUME_PENDING_NOTIFICATIONS) return
    this.child.stdout.resume()
    this.stdoutPaused = false
  }

  private readonly finish = (reason?: Error): void => {
    if (this.closed) return
    this.closed = true

    const failure = reason ?? new Error(this.stderr.trim() || 'Codex app server stopped.')
    for (const request of this.pending.values()) request.reject(failure)
    this.pending.clear()
    for (const waiting of this.waiting.splice(0)) waiting(undefined)
  }

  private attach(): void {
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      const lines = `${this.rest}${chunk}`.split('\n')
      this.rest = lines.pop() ?? ''
      for (const line of lines) {
        const value = jsonRecord(line)
        if (value !== undefined) this.receive(value)
      }
    })
    this.child.stdin.on('error', this.finish)
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT)
    })
    this.child.on('error', this.finish)
    this.child.on('exit', (code) => {
      this.finish(new Error(this.stderr.trim() || `Codex app server exited (${String(code)}).`))
    })
  }
}

/** Opens one official Codex app-server process and completes its initialization handshake. */
export async function openAppServer(binary: string, env: NodeJS.ProcessEnv): Promise<AppServer> {
  const child = spawn(binary, ['app-server', '-c', 'shell_environment_policy.inherit=all'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const server = new AppServerProcess(child)
  try {
    await server.request('initialize', {
      clientInfo: { name: 'handover', version: '0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    return server
  } catch (trouble) {
    server.close()
    throw trouble
  }
}
