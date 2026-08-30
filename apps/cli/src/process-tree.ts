/**
 * Stopping what a stopped turn left running.
 *
 * Asking an agent to stop stops the agent. It does not stop the `npm test` it started thirty
 * seconds ago, and that one goes on burning the machine with nobody waiting for its answer.
 *
 * **Not a process group,** which is the usual answer and is wrong here. A group would take the
 * root down with the branches, and the root is Codex's app-server — one process that lives across
 * every turn on this machine, not per turn. Killing the group would stop the turn by stopping the
 * thing that runs turns. So the tree is walked instead, from a root the caller names.
 *
 * There is a race in it, and it is the right one to lose: a shell started between reading `ps` and
 * sending the signal survives. The alternative is holding something still while an agent works,
 * and an agent that cannot start a process is not an agent. Whatever survives is reaped by the
 * app-server exiting, which happens when this machine stops.
 *
 * Leaves first, so a parent does not spawn a replacement for a child that has just gone.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type RunningProcess = { readonly pid: number; readonly parent: number }

/** Stops the descendants of a process from the leaves inward. */
export async function terminateDescendants(root: number): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid='])
    const processes = processRows(stdout)
    for (const pid of descendants(processes, root).reverse()) terminate(pid)
  } catch {
    // The caller still uses its native interrupt on platforms without this `ps` shape.
  }
}

function processRows(report: string): RunningProcess[] {
  return report
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length >= 2 && row.every(Number.isInteger))
    .map(([pid = 0, parent = 0]) => ({ pid, parent }))
}

function descendants(processes: readonly RunningProcess[], root: number): number[] {
  const family = new Set([root])
  const found: number[] = []

  for (;;) {
    const children = processes
      .filter((process) => family.has(process.parent) && !family.has(process.pid))
      .map((process) => process.pid)
    if (children.length === 0) return found

    for (const child of children) family.add(child)
    found.push(...children)
  }
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // It finished between `ps` and the signal; that is already the requested outcome.
  }
}
