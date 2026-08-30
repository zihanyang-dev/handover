/**
 * The one file that reads the environment, and the three different things it reads it for.
 *
 * Configuration is parsed once and passed down as values. The environment a discovered agent is
 * run in is not configuration — it is what this machine looks like, and it is handed on whole. And
 * the version is not read at all at run time: the build writes it in here.
 */

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Replaced with the released tag while building; genuinely absent when run from source. */
      HANDOVER_VERSION?: string
    }
  }
}

/**
 * Where a checkout runs.
 *
 * Only ever used by a build that came from source — see `main.ts`. A downloaded binary that
 * assumed this would connect somebody's laptop to their own machine and report success, which is
 * the one wrong answer that looks exactly like the right one.
 */
const WHERE_A_CHECKOUT_RUNS = 'http://localhost:3000'

/** What {@link VERSION} says when nothing wrote a tag in, which is what a checkout is. */
export const FROM_SOURCE = 'from source'

/**
 * Which deployment to connect a machine to, when nothing on this machine remembers one yet.
 *
 * Asked once, on the first connect; afterwards the answer is in the attachment. Nothing when this
 * build cannot honestly say — and that is the whole of it: a checkout may assume the machine it
 * is running on, because that is what a checkout is for, and a binary somebody downloaded may
 * not. Defaulted, it connects a laptop to itself, says "connected", and is wrong in the one way
 * that looks exactly like being right.
 *
 * The page that hands out a key hands out the whole line, address included. GitHub's runner,
 * GitLab's runner and Tailscale all do the same — `config.sh --url …`, `register --url …`,
 * `tailscale up --login-server …`.
 */
export function whereToConnect(said: string | undefined, version: string): string | undefined {
  if (said !== undefined) return said

  return version === FROM_SOURCE ? WHERE_A_CHECKOUT_RUNS : undefined
}

/**
 * Which build of this program is running.
 *
 * Reporting a problem with a machine that will not connect starts with this string, so a binary
 * somebody downloaded months ago has to be able to say what it is — with no package.json beside it
 * to read a version out of. The build replaces this one read with the tag, which is also why it is
 * spelled with a dot while everything below uses brackets. Run from source there is no tag to
 * write in, and it says so rather than making up a number.
 */
export const VERSION = process.env.HANDOVER_VERSION ?? FROM_SOURCE

export type Env = {
  /**
   * Where this machine's Space lives, when the environment says.
   *
   * Not defaulted here. Which deployment to connect to is a decision, and the right answer
   * depends on what this build is — `main.ts` makes it, once, out loud.
   */
  readonly origin: string | undefined
  /** Where a user-level attachment is kept, per the XDG convention. */
  readonly configHome: string | undefined
  /**
   * Whether to mention a newer build when somebody connects a machine.
   *
   * Off by setting it to anything, the way `gh` and every other notifier does it: somebody who
   * pins a version has decided, and being told about it on every connect is being told they are
   * wrong about a decision they made on purpose.
   */
  readonly checkForUpdates: boolean
}

export function readEnv(): Env {
  return {
    origin: nonEmpty(process.env['HANDOVER_ORIGIN']),
    configHome: nonEmpty(process.env['XDG_CONFIG_HOME']),
    checkForUpdates: nonEmpty(process.env['HANDOVER_NO_UPDATE_NOTIFIER']) === undefined,
  }
}

/**
 * What a discovered agent is run with.
 *
 * Handed on unchanged, because finding an agent means finding it the way this machine would. A
 * trimmed environment would mean asking a different question than the one somebody asks in their
 * own terminal, and getting a different answer.
 */
export function machineEnvironment(): NodeJS.ProcessEnv {
  return process.env
}

/** An unset variable and one set to nothing mean the same thing: not configured. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

/**
 * How to start this program again: what to execute, and what has to come before its own arguments.
 *
 * Two shapes, and telling them apart is the whole job. A checkout is a runtime holding a script,
 * so both are needed. A downloaded build is one file and there is no script to hand anybody.
 *
 * What a compiled build puts in `argv` is neither of those things: Bun reports
 * `["bun", "/$bunfs/root/handover-darwin-arm64", …]` — the first is a bare word rather than a
 * path, and the second is inside Bun's own virtual root, which exists for the process and for
 * nothing else. `process.execPath` is the one value that is true in both shapes.
 *
 * Asking the filesystem does not work, and that was the second wrong answer: `existsSync` is
 * Bun's, so from inside the binary `/$bunfs/root/…` is a file that exists. It is not a file any
 * shell can run, and a shell is exactly who runs it — the shim an agent calls is `/bin/sh`.
 * So both halves of what Bun reports are read instead, and either one alone is enough.
 *
 * This was wrong in exactly the two places it is used, for every downloaded binary and for no
 * checkout — which is why running from source could never find it. The service file was written
 * with `/$bunfs/…` as its first argument, so the service parsed that as the command, said "no
 * such command" and exited; and the line handed to an agent said `bun /$bunfs/…`, which an agent
 * cannot run either.
 */
export function howToStartThis(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): { readonly executable: string; readonly before: readonly string[] } {
  const [runtime, script] = argv
  if (script === undefined) return { executable: execPath, before: [] }

  // Bun's virtual root, and the bare word it puts where a runtime's path goes. Either says there
  // is no script here. Both are read rather than one, so a change to how Bun spells the first
  // does not quietly bring back a service file nothing can start.
  const isOneFile = script.startsWith('/$bunfs/') || runtime === undefined || !runtime.includes('/')
  if (isOneFile) return { executable: execPath, before: [] }

  return { executable: execPath, before: [script] }
}

/** The same thing as one line, for handing to an agent that has to run it. */
export function howToRunThis(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string {
  const { executable, before } = howToStartThis(argv, execPath)

  return [executable, ...before].map(quoted).join(' ')
}

/** A path with a space in it is one word, and somewhere on somebody's machine there is one. */
function quoted(path: string): string {
  return path.includes(' ') ? `'${path}'` : path
}
