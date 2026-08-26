/** Waiting, in a process that has to be able to stop waiting. */

/**
 * Waits, and stops waiting the moment the signal says so.
 *
 * The second half is not a nicety. Stopping a service is a SIGTERM and then a kill a few seconds
 * later; a loop that only notices when its long sleep ends is killed before it can say goodbye,
 * and the Space goes on showing the machine as here until the silence has run long enough.
 *
 * Both endings clear up after themselves. This is called once per report for as long as a machine
 * is connected — days — and a listener left on the signal each time is a listener per report,
 * held until the process exits: measured at three thousand for three thousand waits.
 */
export async function sleep(seconds: number, until?: AbortSignal): Promise<void> {
  if (until?.aborted === true) return

  const { promise: waited, resolve: wake } = Promise.withResolvers<void>()
  const over = (): void => {
    wake()
  }

  const timer = setTimeout(over, seconds * 1000)
  until?.addEventListener('abort', over, { once: true })

  try {
    await waited
  } finally {
    clearTimeout(timer)
    until?.removeEventListener('abort', over)
  }
}
