/**
 * The one file that reads the environment, and the two different things it reads it for.
 *
 * Configuration is parsed once and passed down as values. The environment a discovered agent is
 * run in is not configuration — it is what this machine looks like, and it is handed on whole.
 */

const DEFAULT_ORIGIN = 'http://localhost:3000'

export type Env = {
  /** Where this machine's Space lives. */
  readonly origin: string
  /** Where a user-level attachment is kept, per the XDG convention. */
  readonly configHome: string | undefined
}

export function readEnv(): Env {
  return {
    origin: nonEmpty(process.env['HANDOVER_ORIGIN']) ?? DEFAULT_ORIGIN,
    configHome: nonEmpty(process.env['XDG_CONFIG_HOME']),
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
