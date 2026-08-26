/**
 * Making `handover` a command the agent can run, whatever this machine looks like.
 *
 * An agent is told to say things back — that it is waiting, that it is finished — and what it is
 * told has to work. "Run `handover`" is an assumption about a PATH nobody checked: this program
 * may be a compiled binary somewhere a service's PATH does not reach, or it may be running from
 * source behind a runtime, in which case there is no `handover` anywhere at all.
 *
 * So it is put there. One tiny script that runs whatever this process is, and the directory it
 * sits in on the front of the PATH the agent is handed. Nobody installs anything, which is the
 * same rule everything else here follows.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

/** What the shim runs. Written by whoever knows how this process was started. */
export type Reaching = {
  /** Where the machine's own file lives; the shim goes beside it. */
  readonly beside: string
  /** How to run this program again, exactly as it was run. */
  readonly howToRun: string
}

/**
 * Writes the shim and says what PATH an agent should be given.
 *
 * Overwritten every time this process starts rather than written once: a machine whose CLI was
 * replaced by somebody re-running the installer would otherwise keep pointing at the old one, and
 * the answer to "which build is that" would be two different things depending on who asked.
 *
 * Nothing is thrown if it cannot be written. A read-only home is a strange machine but not a
 * broken one, and the cost is that the agent has to find `handover` for itself — where the cost
 * of refusing to start would be a machine that answers nothing at all.
 */
export async function reachableAs(reaching: Reaching, env: NodeJS.ProcessEnv): Promise<string> {
  const bin = join(dirname(reaching.beside), 'bin')
  const path = env['PATH'] ?? ''

  try {
    await mkdir(bin, { recursive: true })
    const shim = join(bin, 'handover')
    await writeFile(shim, `#!/bin/sh\nexec ${reaching.howToRun} "$@"\n`)
    await chmod(shim, 0o755)
  } catch {
    return path
  }

  return `${bin}${delimiter}${path}`
}
