/**
 * The only place that writes to standard output; a lint rule holds that line.
 *
 * One JSON object per line, because with more than one instance running the first reader of a log
 * is a machine, and a sentence a person wrote for themselves cannot be grouped, filtered or
 * counted. Where those lines end up is the deployment's business — this writes to stdout and
 * stops there.
 */

import { pino, stdSerializers, type Logger, type LoggerOptions } from 'pino'
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
  // Errors are the one value that arrives as prose. Serialized whole, a connection string or a
  // signed URL that somebody quoted into a message goes to the log with it — and a log outlives
  // the request by months.
  serializers: {
    err: (error: unknown) => {
      const written = stdSerializers.err(error as Error)
      // Both are optional on the way out: what arrives here is whatever was thrown, and not
      // everything thrown is an Error.
      return {
        ...written,
        ...(typeof written.message === 'string'
          ? { message: withoutSecrets(written.message) }
          : {}),
        ...(typeof written.stack === 'string' ? { stack: withoutSecrets(written.stack) } : {}),
      }
    },
  },
}

/**
 * The shapes a secret takes when it is inside a sentence rather than in a field of its own.
 *
 * Redacting by field name cannot reach these: what is logged is one string — an error's message,
 * or its stack — and a connection string or a signed URL sitting inside it is not a field anybody
 * can name. What is kept is the part that says what broke; what goes is the part that opens it.
 */
const IN_A_SENTENCE: readonly (readonly [RegExp, string])[] = [
  // `postgres://user:hunter2@host` — the password, and nothing else about it.
  [/(:\/\/[^\s:/@]+:)[^\s@]+(@)/gu, '$1[redacted]$2'],
  // `?token=…`, `&access_token=…`, `&api_key=…` — the value, with the name left readable.
  [/([?&](?:[\w-]*(?:token|secret|key|password)[\w-]*)=)[^&\s]+/giu, '$1[redacted]'],
  // A bearer token wherever it was quoted into a message.
  [/(bearer\s+)[\w.\-~+/]+=*/giu, '$1[redacted]'],
]

/** One sentence, with anything that opens something taken out of it. */
export function withoutSecrets(said: string): string {
  let left = said
  for (const [looks, instead] of IN_A_SENTENCE) left = left.replace(looks, instead)

  return left
}

export type Log = Logger

export function createLog(env: Env): Log {
  return pino({ ...LOG_OPTIONS, level: env.LOG_LEVEL })
}
