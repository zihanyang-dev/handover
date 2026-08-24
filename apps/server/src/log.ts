/**
 * The only place that writes to standard output; a lint rule holds that line.
 *
 * One JSON object per line, because with more than one instance running the first reader of a log
 * is a machine, and a sentence a person wrote for themselves cannot be grouped, filtered or
 * counted. Where those lines end up is the deployment's business — this writes to stdout and
 * stops there.
 */

import { pino, type Logger, type LoggerOptions } from 'pino'
import type { Env } from './env.ts'

/**
 * Secrets get censored on the way out rather than being trusted never to arrive. Passing one is
 * still a mistake; this is what keeps the mistake from being permanent and searchable.
 *
 * Only names that are a secret every time they appear. `code` was here and had to go: it censored
 * `EADDRINUSE` out of a crash report, and a redaction that eats the useful half of a log teaches
 * people to turn it off.
 */
const SECRETS = [
  'token',
  'tokenHash',
  'codeHash',
  'secret',
  'clientSecret',
  'password',
  'cookie',
  'authorization',
]

export const LOG_OPTIONS: LoggerOptions = {
  redact: {
    paths: [...SECRETS, ...SECRETS.map((name) => `*.${name}`)],
    censor: '[redacted]',
  },
  formatters: {
    // The word, not the number. Nobody grepping a log knows that 30 means info.
    level: (label) => ({ level: label }),
  },
}

export type Log = Logger

export function createLog(env: Env): Log {
  return pino({ ...LOG_OPTIONS, level: env.LOG_LEVEL })
}
