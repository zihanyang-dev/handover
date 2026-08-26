/**
 * An `EventSource` for the tests, because the environment they run in has none.
 *
 * A screen test that could not open a live stream would be a screen test that never renders the
 * live half at all — and the thing worth testing is exactly what a person sees while a turn runs.
 * This is the browser's API and nothing more: what it adds is a way for a test to say what the
 * server sent.
 */

type Listener = (event: MessageEvent<string>) => void

class TestEventSource {
  static readonly open = new Map<string, TestEventSource>()

  onmessage: Listener | null = null
  onopen: (() => void) | null = null
  closed = false
  readonly url: string

  constructor(url: string) {
    this.url = url
    TestEventSource.open.set(url, this)
    // Never in the constructor: the real one connects over a network, and nobody has had a chance
    // to say what to do when it opens until after `new` has returned.
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.()
    })
  }

  close(): void {
    this.closed = true
    TestEventSource.open.delete(this.url)
  }
}

/** What the server sent, to whoever is watching that conversation. */
export function serverSends(url: string, data: unknown): void {
  const live = TestEventSource.open.get(url)
  if (live === undefined) throw new Error(`nobody is watching ${url}`)

  live.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
}

/** Whether a browser is holding a stream open. */
export function isWatching(url: string): boolean {
  return TestEventSource.open.has(url)
}

globalThis.EventSource = TestEventSource as unknown as typeof EventSource
