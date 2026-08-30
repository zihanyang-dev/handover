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
