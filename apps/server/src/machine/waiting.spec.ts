import { describe, expect, it } from 'vitest'
import { waitingRoom } from './waiting.ts'

/** Long enough that nothing here can pass by timing out. A test that waits is a test that lies. */
const NEVER = 30

/** Short enough to sit through, for the one case that is about the hold ending on its own. */
const AT_ONCE = 0.01

/** What the tables hold, as far as this file is concerned: one thing to do, or nothing yet. */
type Written = { work?: string }

/** A look that answers whatever is written down at the moment it is asked. */
function reading(written: Written) {
  return async (): Promise<string | undefined> => written.work
}

describe('answering a machine question', () => {
  it('answers the first look, when there is already something there', async () => {
    const room = waitingRoom(NEVER)

    expect(await room.somethingFor('m-1', reading({ work: 'turn-1' }))).toBe('turn-1')
  })

  it('looks again once somebody has something, and answers with that', async () => {
    // The whole point: what arrives while the question is held is what the question is answered
    // with, rather than a "nothing" that makes the next thing wait for the next report.
    const room = waitingRoom(NEVER)
    const written: Written = {}

    const asking = room.somethingFor('m-1', reading(written))
    written.work = 'turn-1'
    room.wake('m-1')

    expect(await asking).toBe('turn-1')
  })

  it('hears a waking that lands while the first look is still running', async () => {
    // The reason looking belongs to this function. Written the other way round — look, then start
    // waiting — this waking falls in the gap, and the request holds for the full time with the
    // answer already written down.
    const room = waitingRoom(NEVER)
    const written: Written = {}
    const look = reading(written)
    let looks = 0

    const asking = room.somethingFor('m-1', async () => {
      // What this look sees is read first — nothing — and only then does somebody say
      // something. That is the gap: it happened before the wait began, and anybody who
      // started listening afterwards would miss it.
      const found = await look()
      if (looks++ === 0) {
        written.work = 'turn-1'
        room.wake('m-1')
      }

      return found
    })

    expect(await asking).toBe('turn-1')
  })

  it('answers with nothing once the hold is over', async () => {
    const room = waitingRoom(AT_ONCE)

    expect(await room.somethingFor('m-1', reading({}))).toBeUndefined()
  })

  it('is not woken by news about another machine', async () => {
    const room = waitingRoom(AT_ONCE)
    let looks = 0

    await room.somethingFor('m-1', async () => {
      looks += 1
      room.wake('m-2')
      return undefined
    })

    // Two looks: the first, and the one the hold running out asked for. Not three, and not one.
    expect(looks).toBe(2)
  })

  it('answers everybody at once when this instance is stopping', async () => {
    const room = waitingRoom(NEVER)
    const both = [room.somethingFor('m-1', reading({})), room.somethingFor('m-2', reading({}))]

    room.wakeEveryone()

    expect(await Promise.all(both)).toEqual([undefined, undefined])
  })

  it('holds two questions for one machine, and answers both', async () => {
    // One machine asking twice is what a restart looks like, or two machines sharing a credential.
    // Neither is normal, and neither may leave a request held forever.
    const room = waitingRoom(NEVER)
    const both = [room.somethingFor('m-1', reading({})), room.somethingFor('m-1', reading({}))]

    room.wake('m-1')

    expect(await Promise.all(both)).toEqual([undefined, undefined])
  })

  it('keeps nothing for a machine that has gone', async () => {
    // An instance up for a month must not hold one empty set per machine that ever asked. The
    // only way to see the room is empty is that waking a machine nobody waits for does nothing.
    const room = waitingRoom(AT_ONCE)
    await room.somethingFor('m-1', reading({}))

    expect(() => {
      room.wake('m-1')
    }).not.toThrow()
  })
})
