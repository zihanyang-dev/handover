/**
 * The machines whose questions this instance is holding.
 *
 * A machine asks "is there anything for me". Answering "no" at once means the next thing anybody
 * says to it waits out the gap until it asks again — which is the whole of the delay a person
 * feels between pressing send and the agent starting. So the question is held instead, and the
 * answer arrives when there is one.
 *
 * Held here and not in the database, because it is not a fact: it is a request this process has
 * not answered yet, and it dies with the process. What crosses between instances is the waking,
 * and that goes through Postgres — see `db/waking.ts`.
 */

export type Waiting = {
  /**
   * Answers one machine's question, waiting for something to say if there is nothing yet.
   *
   * Looking is this function's to do rather than the caller's, because the order is the whole
   * correctness of it: whoever waits has to be listening **before** the first look, or a waking
   * that lands while the tables are being read is missed — and the request then holds for the
   * full time with its answer already written down.
   *
   * Two looks and no more. The second is what the wait was for, and whatever it finds is the
   * answer, including nothing.
   */
  readonly answerFor: <T>(
    machineId: string,
    look: () => Promise<T>,
    enough: (found: T) => boolean,
  ) => Promise<T>
  /** Somebody has something for this machine. Every request being held for it looks again now. */
  readonly wake: (machineId: string) => void
  /**
   * This instance is stopping.
   *
   * Held requests are answered at once rather than drained, because draining them means waiting
   * out the hold — and a deploy that takes that long to finish is a deploy that looks broken. The
   * machines simply ask again, and land wherever they land.
   */
  readonly wakeEveryone: () => void
}

/**
 * A room that holds each question for this long.
 *
 * Shorter is always safe: a machine held for less reports more often than the silence threshold
 * expects, and stays counted as here. Longer is not — it would let a machine be called gone while
 * this very instance was holding its question. See `SILENT_FOR_SECONDS`.
 */
export function waitingRoom(holdSeconds: number): Waiting {
  const held = new Map<string, Set<() => void>>()

  const wake = (machineId: string): void => {
    for (const answer of held.get(machineId) ?? []) answer()
  }

  return {
    wake,

    wakeEveryone: () => {
      // Nothing is removed while this runs: answering only settles a promise, and the request
      // that was waiting takes its own name out afterwards.
      for (const machineId of held.keys()) wake(machineId)
    },

    answerFor: async (machineId, look, enough) => {
      const waiters = held.get(machineId) ?? new Set<() => void>()
      held.set(machineId, waiters)

      let answer = (): void => undefined
      const woken = new Promise<void>((done) => {
        answer = done
      })
      waiters.add(answer)

      try {
        const found = await look()
        if (enough(found)) return found

        await Promise.race([woken, after(holdSeconds)])
        return await look()
      } finally {
        waiters.delete(answer)
        // The last one waiting for a machine takes its name with it, so an instance that has been
        // up for a month is not holding one empty set per machine that ever asked.
        if (waiters.size === 0) held.delete(machineId)
      }
    },
  }
}

/** The hold running out, which is one of the three things that ends a wait. */
async function after(seconds: number): Promise<void> {
  return new Promise((over) => {
    // Unreferenced, so a hold in flight cannot be what keeps this process alive on the way out.
    setTimeout(over, seconds * 1000).unref()
  })
}
