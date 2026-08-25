/**
 * Where a command actually is on this machine.
 *
 * Both SDKs fall back to a copy of the agent they ship with — hundreds of megabytes, signed into
 * nothing — unless they are told where the real one is. The real one is whichever the person
 * installed, which is the one holding their login, so it has to be found rather than assumed.
 *
 * PATH here is the one captured when this machine was connected. A service does not inherit the
 * PATH a person has in their terminal, and looking one up at run time is how a machine ends up
 * reporting that it has no agents at all.
 */

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export async function onPath(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter((one) => one !== '')) {
    const candidate = join(dir, command)
    if (await runnable(candidate)) return candidate
  }

  return undefined
}

async function runnable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    // Not there, or not ours to run. Either way this is not the one; keep looking.
    return false
  }
}
