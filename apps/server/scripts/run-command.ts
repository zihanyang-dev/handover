/** Running a child command and failing loudly when it does not succeed. */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const ROOT = join(import.meta.dirname, '..')

/** A dependency's executable, resolved without relying on PATH. */
export function binary(name: string): string {
  return join(ROOT, 'node_modules', '.bin', name)
}

/**
 * A command that did not exit 0 leaves the repository in an unknown state, so there is one
 * recovery — read the output above and fix it — and therefore one error.
 */
export function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Same contract as {@link run}, but the child's stdout is returned instead of inherited. */
export function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
  return result.stdout
}
