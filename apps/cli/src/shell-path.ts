/**
 * The PATH a person's own terminal would have.
 *
 * A service does not inherit it. launchd hands over `/usr/bin:/bin:/usr/sbin:/sbin` and systemd
 * hands over less — and finding agents *is* looking along PATH, so a machine that works when run
 * by hand finds nothing at all once it is a service. Worse, it says so as "no agents here", which
 * points nowhere near the cause.
 *
 * Asking the login shell is the known answer to this and the known nuisance: VS Code's "unable to
 * resolve your shell environment" is this, on a shell that took too long. So it is bounded, and
 * what it fell back to is something {@link resolvedPath} reports rather than hides.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A heavy shell profile takes a moment. Longer than this and the machine gets on with its job. */
const GIVE_UP_AFTER_MS = 3000

export type ResolvedPath = {
  readonly path: string
  /** Which one this is, because "no agents found" reads differently depending on the answer. */
  readonly from: 'login-shell' | 'this-process'
}

export async function resolvedPath(
  env: NodeJS.ProcessEnv,
  shell: string | undefined,
): Promise<ResolvedPath> {
  const ours = { path: env['PATH'] ?? '', from: 'this-process' } as const

  if (shell === undefined) return ours

  try {
    const { stdout } = await run(shell, ['-lc', 'printf %s "$PATH"'], {
      env,
      timeout: GIVE_UP_AFTER_MS,
      windowsHide: true,
    })
    const path = stdout.trim()
    return path === '' ? ours : { path, from: 'login-shell' }
  } catch {
    // A shell that is slow, missing, or errors in its own profile. None of those should stop a
    // machine checking in; they should only mean it looks in fewer places, visibly.
    return ours
  }
}
