/** Turning the bearer token a machine sends into the machine it belongs to. */

import { createMiddleware } from 'hono/factory'
import { machineHolding } from '../db/machine.ts'
import type { Database } from '../db/connection.ts'
import { hashSecret } from '../machine/secret.ts'
import { body, type Failure } from './failure.ts'

export type Attached = { machineId: string }

/**
 * Nobody's machine.
 *
 * Separate from the answer a browser gets, because the recovery is different in kind: a person
 * signs in again, a machine has to be enrolled again by a person. Telling a machine to "sign in"
 * would be telling it to do something it cannot do.
 */
const NOT_A_MACHINE: Failure<401> = {
  reason: 'no-machine',
  recovery: 'start-over',
  status: 401,
}

/**
 * Refuses everything that is not a live machine credential.
 *
 * Deliberately does not accept a browser session. The two are different holders with different
 * powers — a machine may report what it found and take work, a person may read a Space and remove
 * machines — and one door that opened to both would be the weaker of the two everywhere.
 */
export function requireMachine(db: Database) {
  return createMiddleware<{ Variables: Attached }>(async (c, next) => {
    const machineId = await machineFrom(db, c.req.header('authorization'))

    if (machineId === undefined) return c.json(body(NOT_A_MACHINE), NOT_A_MACHINE.status)

    c.set('machineId', machineId)
    await next()
    return undefined
  })
}

async function machineFrom(
  db: Database,
  authorization: string | undefined,
): Promise<string | undefined> {
  const bearer = authorization?.match(/^Bearer (?<token>\S+)$/u)?.groups?.['token']
  return bearer === undefined ? undefined : machineHolding(db, hashSecret(bearer))
}
