/**
 * Finding out which agents are on this machine.
 *
 * The list of what to look for belongs to the server — it is the one that decides what it knows
 * how to run — so this asks for it rather than carrying its own copy. A machine with a newer list
 * than the server would report agents the server would drop; a stale one would hide agents the
 * server could have used.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Long enough for a cold binary on a slow disk, short enough not to hold up a check-in. */
const GIVE_UP_AFTER_MS = 5000

export type Found = {
  readonly command: string
  readonly version: string
}

/**
 * What each command answers when asked its version, for the ones that answer at all.
 *
 * A command that is missing, refuses to run, or hangs is simply not found. None of those is worth
 * telling the server apart: the machine either has a working agent or it does not.
 */
export async function findAgents(
  commands: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Found[]> {
  const asked = await Promise.all(commands.map(async (command) => askVersion(command, env)))
  return asked.filter((one) => one !== undefined)
}

async function askVersion(command: string, env: NodeJS.ProcessEnv): Promise<Found | undefined> {
  try {
    const { stdout } = await run(command, ['--version'], {
      env,
      timeout: GIVE_UP_AFTER_MS,
      windowsHide: true,
    })
    const version = firstVersion(stdout)
    return version === undefined ? undefined : { command, version }
  } catch {
    // Not installed, not runnable, or too slow to answer. All the same to a machine that has to
    // report what it can actually use.
    return undefined
  }
}

/**
 * The version out of whatever the command printed.
 *
 * Every one of these prints something different around the number — a name, a build, a banner —
 * so the number is what gets taken and the rest is left where it is.
 */
function firstVersion(printed: string): string | undefined {
  return /\d+\.\d+\.\d+[\w.-]*/u.exec(printed)?.[0]
}
