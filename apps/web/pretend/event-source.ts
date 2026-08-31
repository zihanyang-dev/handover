/**
 * An `EventSource` for the tests, because the environment they run in has none.
 *
 * A screen test that could not open a live stream would never render the live half at all — and
 * what a person sees while a turn runs is exactly the thing worth testing.
 *
 * **What this is not is proof that anything arrives.** It hands a callback whatever a test says
 * the server sent, so every green light here is about what a page does with an event. The wire
 * itself — the notify between instances, the hub, the stream — is proven in
 * `server/live-api.spec.ts`, against real `text/event-stream` bytes.
 *
 * It answers to the parts of the real API this app uses, and *only* those, so a screen that
 * reaches for something else fails here rather than in a browser: named events go through
 * `addEventListener`, not `onmessage`, and a page that listens on the wrong one sees silence.
 */

type Listener = (event: MessageEvent<string>) => void

class TestEventSource {
  static readonly open = new Map<string, TestEventSource>()

  onmessage: Listener | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  readonly url: string
  readonly named = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
    TestEventSource.open.set(url, this)
    // Never in the constructor: the real one connects over a network, and nobody has had a chance
    // to say what to do when it opens until after `new` has returned.
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.()
    })
  }

  addEventListener(name: string, listener: Listener): void {
    const here = this.named.get(name) ?? new Set<Listener>()
    here.add(listener)
    this.named.set(name, here)
  }

  removeEventListener(name: string, listener: Listener): void {
    this.named.get(name)?.delete(listener)
  }

  close(): void {
    this.closed = true
    TestEventSource.open.delete(this.url)
  }
}

/**
 * What the server sent, to whoever is watching that conversation.
 *
 * `event` names it, the way the server names its heartbeat. Unnamed is what reaches `onmessage`;
 * a named one reaches only a listener asking for that name, which is the browser's rule and the
 * one a page is easiest to get wrong.
 */
export function serverSends(url: string, data: unknown, event?: string): void {
  const live = TestEventSource.open.get(url)
  if (live === undefined) throw new Error(`nobody is watching ${url}`)

  const arrived = new MessageEvent(event ?? 'message', { data: JSON.stringify(data) })
  if (event === undefined) live.onmessage?.(arrived)
  else for (const listener of live.named.get(event) ?? []) listener(arrived)
}

// SAFETY: tests use only EventSource construction, listeners, ready state, and close; this double
// implements those members and intentionally omits browser-only fields no test can observe.
globalThis.EventSource = TestEventSource as unknown as typeof EventSource
