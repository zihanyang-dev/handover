import { describe, expect, it } from 'vitest'
import type { Watched } from './live.ts'
import { watchers } from './watchers.ts'

const TYPING: Watched = { seen: 'typing', who: 'mina' }

const WRITTEN: Watched = { seen: 'written', upTo: 7 }

describe('the browsers this instance is holding open', () => {
  it('shows one thing to everybody watching that conversation', () => {
    const here = watchers()
    const seen: Watched[] = []
    here.watch('c-1', (watched) => seen.push(watched))
    here.watch('c-1', (watched) => seen.push(watched))

    here.show({ conversationId: 'c-1', watched: TYPING })

    expect(seen).toEqual([TYPING, TYPING])
  })

  it('shows nothing to somebody watching a different conversation', () => {
    const here = watchers()
    const seen: Watched[] = []
    here.watch('c-2', (watched) => seen.push(watched))

    here.show({ conversationId: 'c-1', watched: WRITTEN })

    expect(seen).toEqual([])
  })

  it('stops showing to one that went, and goes on showing to the one that stayed', () => {
    const here = watchers()
    const seen: Watched[] = []
    const gone = here.watch('c-1', () => seen.push(TYPING))
    here.watch('c-1', (watched) => seen.push(watched))

    gone()
    here.show({ conversationId: 'c-1', watched: WRITTEN })

    expect(seen).toEqual([WRITTEN])
  })

  it('keeps nothing for a conversation nobody is watching any more', () => {
    // A server up for a month must not hold one empty set per conversation anybody ever opened.
    // The only way to see that from out here is that showing to one nobody watches does nothing.
    const here = watchers()
    here.watch('c-1', () => undefined)()

    expect(() => {
      here.show({ conversationId: 'c-1', watched: WRITTEN })
    }).not.toThrow()
  })
})
