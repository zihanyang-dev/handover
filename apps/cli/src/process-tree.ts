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
