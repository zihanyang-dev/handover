import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { sleep } from './sleeping.ts'

describe('waiting', () => {
  it('comes back when the time is up', async () => {
    const began = performance.now()

    await sleep(0.02)

    expect(performance.now() - began).toBeGreaterThanOrEqual(15)
  })

  it('comes back at once when asked to stop', async () => {
    const stopping = new AbortController()
    const began = performance.now()

    const waited = sleep(30, stopping.signal)
    stopping.abort()
    await waited

    expect(performance.now() - began).toBeLessThan(100)
  })

  it('does not wait at all when the asking is already over', async () => {
    // A loop that checks the signal and then waits has a gap between the two, and a stop landing
    // in it would otherwise be a full sleep spent by a process that was already on its way out.
    const stopping = new AbortController()
    stopping.abort()
    const began = performance.now()

    await sleep(30, stopping.signal)

    expect(performance.now() - began).toBeLessThan(100)
  })

  it('leaves nothing on the signal, however many times it is called', async () => {
    // Once per report, for as long as a machine is connected. Left behind, each wait costs one
    // listener held until the process exits — three thousand waits, three thousand listeners.
    const stopping = new AbortController()

    for (let n = 0; n < 500; n += 1) await sleep(0, stopping.signal)

    expect(getEventListeners(stopping.signal, 'abort')).toHaveLength(0)
  })
})
