/**
 * What a person does about a machine asking to come in: look at it, say yes, say no.
 *
 * A live session is the whole of the standing any of it needs. Nothing here names a Space,
 * because a machine is not in one: it is somebody's, and where it can be reached from follows
 * from where they are a member.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import {
  approveEnrolment,
  enrolmentWaiting,
  openEnrolment,
  refuseEnrolment,
} from '../db/enrolment.ts'
import { newEnrolmentSecret } from '../machine/secret.ts'
import { readUserCode } from '../machine/user-code.ts'
import { SHOWS, api, endpointsBehind, saysNothing, sends, takes } from './contract.ts'
import { BEHIND_A_SESSION, body, refusal, type Failure } from './failure.ts'
import { requireSession, type Signed } from './session.ts'

export type ApprovalApi = { readonly db: Database }

/** No enrolment is waiting under that code: never was, already answered, or ran out. */
const NOT_WAITING: Failure<404> = { reason: 'no-enrolment', recovery: 'start-over', status: 404 }

const waitingBody = z
  .object({ machineName: z.string(), expiresAt: z.iso.datetime() })
  .openapi('MachineWaiting')

/** Shown once. Only its hash is kept, so this is the only moment it can be read. */
const keyBody = z.object({ key: z.string(), expiresAt: z.iso.datetime() }).openapi('MachineKey')

const behindASession = endpointsBehind<{ Variables: Signed }>(SHOWS.session)

/**
 * Answering a machine, and saying yes to one in advance.
 *
 * None of it names a Space. What somebody answers is whose the machine is, and where it can be
 * reached from follows from where they are a member — which is not a decision made here.
 */
export function approvalApi(deps: ApprovalApi) {
  return api<{ Variables: Signed }>().openapiRoutes([
    whatIsWaiting(deps),
    refusing(deps),
    approving(deps),
    makingAKey(deps),
  ])
}

/** Looking at a machine before answering it. */
function whatIsWaiting(deps: ApprovalApi) {
  return behindASession({
    route: createRoute({
      method: 'get',
      path: '/enrolments/{userCode}',
      summary: 'What is asking to come in under this code',
      middleware: [requireSession(deps.db)],
      request: { params: z.object({ userCode: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(waitingBody, 'A machine is waiting on an answer'),
        404: refusal('Nothing is waiting under that code'),
      },
    }),

    handler: async (c) => {
      const userCode = readUserCode(c.req.valid('param').userCode)
      const waiting = userCode === undefined ? undefined : await enrolmentWaiting(deps.db, userCode)

      if (waiting === undefined) return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.json(
        { machineName: waiting.machineName, expiresAt: waiting.expiresAt.toISOString() },
        200,
      )
    },
  })
}

/**
 * Saying yes, which makes that machine yours.
 *
 * Answering adds a machine to the ones you have, so this creates one there — and its opposite,
 * `DELETE /me/machines/{id}`, is the standard method for taking one away.
 */
function approving(deps: ApprovalApi) {
  return behindASession({
    route: createRoute({
      method: 'post',
      path: '/me/machines',
      summary: 'Say that machine is yours',
      middleware: [requireSession(deps.db)],
      request: {
        body: takes(z.object({ userCode: z.string().max(64) }).openapi('LetItIn')),
      },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('It is yours'),
        404: refusal('Nothing is waiting under that code'),
      },
    }),

    handler: async (c) => {
      const userCode = readUserCode(c.req.valid('json').userCode)
      if (userCode === undefined) return c.json(body(NOT_WAITING), NOT_WAITING.status)

      const answered = await approveEnrolment(deps.db, userCode, { userId: c.get('userId') })
      if (answered.kind === 'not-waiting') return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.body(null, 204)
    },
  })
}

/**
 * Saying yes in advance: an enrolment that arrives approved.
 *
 * Not a second mechanism. Somebody generating one has already made the decision the code path
 * asks a person to make — that the machine will be theirs — so the row is written with that
 * decision on it, and the machine that presents it skips only the waiting.
 *
 * Yours, like everything else about a machine. It was under a Space while a machine belonged to
 * one; now it names nothing but who made it, and a route behind a Space membership would be a
 * gate in front of a decision the Space has no part in.
 *
 * For a machine with no browser to open, which is most machines that are not somebody's laptop.
 */
function makingAKey(deps: ApprovalApi) {
  return behindASession({
    route: createRoute({
      method: 'post',
      path: '/me/machine-keys',
      summary: 'Make a key a machine can come in with, without anybody approving it later',
      middleware: [requireSession(deps.db)],
      request: {},
      responses: {
        ...BEHIND_A_SESSION,
        201: sends(keyBody, 'The key, shown this once and never again'),
      },
    }),

    handler: async (c) => {
      const secret = newEnrolmentSecret()

      // A key: no code and no machine name, because nobody will read one and nobody knows the
      // other yet. Which of those an enrolment has is the shape, not four fields left blank.
      const opened = await openEnrolment(deps.db, {
        kind: 'key',
        secretHash: secret.hash,
        approvedBy: c.get('userId'),
      })

      return c.json({ key: secret.secret, expiresAt: opened.expiresAt.toISOString() }, 201)
    },
  })
}

/** Saying no, which is final: asking again under the same code will not change it. */
function refusing(deps: ApprovalApi) {
  return behindASession({
    route: createRoute({
      method: 'post',
      path: '/enrolments/{userCode}/refuse',
      summary: 'Turn that machine away',
      middleware: [requireSession(deps.db)],
      request: { params: z.object({ userCode: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('It may not come in, and asking again will not change that'),
        404: refusal('Nothing is waiting under that code'),
      },
    }),

    handler: async (c) => {
      const userCode = readUserCode(c.req.valid('param').userCode)
      const answered =
        userCode === undefined
          ? ({ kind: 'not-waiting' } as const)
          : await refuseEnrolment(deps.db, userCode)

      if (answered.kind === 'not-waiting') return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.body(null, 204)
    },
  })
}
