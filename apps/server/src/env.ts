/**
 * The only module permitted to read `process.env`; a lint rule holds that line. Everywhere else
 * receives an already-parsed `Env`, so no code path can observe an unvalidated value.
 */

import { z } from 'zod'
import { PROVIDERS, type Provider } from './identity/provider.ts'

const SHAPE = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Keys the hash of an emailed code. Long enough that knowing a hash does not reveal the code. */
  AUTH_SECRET: z.string().min(32),
  /**
   * Connections this process may hold. Every instance holds its own, so the number that matters
   * is this times the instance count, and it has to stay under the server's `max_connections`
   * with room left for migrations and whoever needs to look at the database by hand.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /**
   * Where a browser reaches this server. A provider redirects back to an address built from it,
   * and will refuse any that was not registered over there, so it cannot be guessed per request.
   */
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  /**
   * Where the browser app lives. It is not always where this server lives: a provider sends the
   * browser back here, and here has to send it on to a page, which may be a separate deployment.
   */
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:5173'),
  /**
   * How many codes one caller may ask for in an hour.
   *
   * The per-address wait is no defence against somebody rotating addresses, and every one of those
   * letters costs money and spends the sending domain's reputation — a domain marked as a source
   * of spam takes months to recover. Counted per caller rather than across the deployment: a
   * ceiling over everybody is one an attacker can burn through to keep real people from signing
   * in, which trades an uncertain bill for a certain outage.
   */
  LETTERS_PER_CALLER_PER_HOUR: z.coerce.number().int().min(1).default(20),

  /**
   * How many proxies stand in front of this process.
   *
   * Zero — the default — means the connection is the caller, and `X-Forwarded-For` is ignored:
   * unset, that header is written by whoever is calling, and trusting it turns the limit above
   * into a counter anybody can reset. One means the last entry was written by our own proxy, two
   * means the one before that, and so on. It is a fact about the deployment, so the deployment
   * says it.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /**
   * Where the built browser app is, when this process serves it itself.
   *
   * Unset, this is an API and nothing else — which is what a deployment with a proxy or a CDN in
   * front of the pages wants. Set, one origin answers for both, and that is not a preference: the
   * page's calls carry no origin of their own and its session cookie is `SameSite=Lax`, so a page
   * served from somewhere else would be a page that cannot stay signed in.
   */
  WEB_ROOT: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /**
   * What this process is. No default, on purpose.
   *
   * Defaulted to development, a production deployment that never set it gets every development
   * convenience — including the sign-in code going to the log rather than to an inbox. A process
   * that has not been told what it is refuses to start, which is one line in a deployment and the
   * difference between failing closed and failing open.
   */
  NODE_ENV: z.enum(['development', 'test', 'production']),
  /** Given, letters go out. Missing, they do not, and the process says so rather than pretending. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * Whom letters come from. Resend only accepts an address on a domain it has verified, apart
   * from its own sandbox one, which reaches the account holder and nobody else.
   */
  MAIL_FROM: z.email().default('onboarding@resend.dev'),
  /**
   * A provider is offered only when both of its values are here. Half a pair is a configuration
   * mistake, not a provider, and it fails `withPairs` rather than half-working at sign-in.
   */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
})

export type Env = z.infer<typeof SHAPE>

/** An unset variable and one set to the empty string mean the same thing: absent. */
function assigned(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
}

function explain(issue: z.core.$ZodIssue): string {
  const name = issue.path.join('.')
  if (issue.code === 'invalid_type') return `  ${name} is not set`
  return `  ${name}: ${issue.message}`
}

/**
 * A broken environment has one actor and one recovery — fix it and start again — so it is one
 * error. It names every problem at once; reporting them one at a time costs one restart each.
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const parsed = SHAPE.safeParse(assigned(source))
  if (parsed.success) return withPairs(parsed.data)

  const problems = parsed.error.issues.map(explain).join('\n')
  throw new Error(`environment is not usable:\n${problems}\n\nsee .env.example`)
}

/**
 * Where each provider's keys are read from. Required, one entry per provider: adding a name
 * without saying where its keys live is a compile error, not a provider that silently never
 * appears. Written out rather than derived, because static names are what make `Env` typed.
 */
export const PROVIDER_KEYS = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
} as const satisfies Record<Provider, readonly [keyof Env, keyof Env]>

/** An id without its secret, or the other way round, is somebody halfway through a setup. */
function withPairs(env: Env): Env {
  const broken = PROVIDERS.map((provider) => PROVIDER_KEYS[provider]).filter(
    ([id, secret]) => (env[id] === undefined) !== (env[secret] === undefined),
  )
  if (broken.length === 0) return env

  const named = broken.map(([id, secret]) => `  ${id} and ${secret} go together`).join('\n')
  throw new Error(`environment is not usable:\n${named}\n\nsee .env.example`)
}

/** The single read of `process.env` in this repository. */
export function loadEnv(): Env {
  return parseEnv(process.env)
}
