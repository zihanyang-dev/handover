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

const DEFAULT_ORIGIN = 'http://localhost:3000'

/**
 * Which build of this program is running.
 *
 * Reporting a problem with a machine that will not connect starts with this string, so a binary
 * somebody downloaded months ago has to be able to say what it is — with no package.json beside it
 * to read a version out of. The build replaces this one read with the tag, which is also why it is
 * spelled with a dot while everything below uses brackets. Run from source there is no tag to
 * write in, and it says so rather than making up a number.
 */
export const VERSION = process.env.HANDOVER_VERSION ?? 'from source'

export type Env = {
  /** Where this machine's Space lives. */
  readonly origin: string
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
    origin: nonEmpty(process.env['HANDOVER_ORIGIN']) ?? DEFAULT_ORIGIN,
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
 * How to run this program again, exactly as it was run.
 *
 * The agent has to be able to say things back — "I am waiting on you", "this is finished" — and
 * what it is told to run must be a command that actually works on the machine it is on. `handover`
 * usually is on the PATH, because that is how it got connected in the first place. It is not when
 * this is running from source, and it is not when somebody put the binary somewhere a service's
 * PATH does not reach.
 *
 * So nothing is assumed. A compiled binary is its own path; source is the runtime and the file.
 * Either way the agent is handed something it can run without looking for anything.
 */
export function howToRunThis(argv: readonly string[] = process.argv): string {
  const [runtime, file] = argv
  if (runtime === undefined) return 'handover'

  // A single-file build reports itself as both — there is no script to hand to a runtime.
  if (file === undefined || runtime === file) return quoted(runtime)

  return `${quoted(runtime)} ${quoted(file)}`
}

/** A path with a space in it is one word, and somewhere on somebody's machine there is one. */
function quoted(path: string): string {
  return path.includes(' ') ? `'${path}'` : path
}
