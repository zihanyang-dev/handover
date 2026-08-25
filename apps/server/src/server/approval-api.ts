/**
 * What a person does about a machine asking to come in: look at it, say yes, say no.
 *
 * Every route here is behind a live session, and saying yes needs more than that: it needs
 * membership of the Space being joined. That membership is the whole of somebody's standing to
 * let a machine in.
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
import { SHOWS, api, endpointsBehind, saysNothing, sends } from './contract.ts'
import { BEHIND_A_SESSION, body, refusal, type Failure } from './failure.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type ApprovalApi = { readonly db: Database }

/** No enrolment is waiting under that code: never was, already answered, or ran out. */
const NOT_WAITING: Failure<404> = { reason: 'no-enrolment', recovery: 'start-over', status: 404 }

const waitingBody = z
  .object({ machineName: z.string(), expiresAt: z.iso.datetime() })
  .openapi('MachineWaiting')

/** Shown once. Only its hash is kept, so this is the only moment it can be read. */
const keyBody = z.object({ key: z.string(), expiresAt: z.iso.datetime() }).openapi('MachineKey')

/**
 * Two doors, two apps.
 *
 * Looking at a machine and turning one away need a session and nothing more — a code is not about
 * a Space until somebody picks one. Saying yes needs membership of the Space being joined, which
 * is the whole of somebody's standing to let a machine in.
 */
const behindASession = endpointsBehind<{ Variables: Signed }>(SHOWS.session)
const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>(SHOWS.session)

export function approvalApi(deps: ApprovalApi) {
  return api<{ Variables: Signed }>()
    .openapiRoutes([whatIsWaiting(deps), refusing(deps)])
    .route('/', intoASpace(deps))
}

/** The half that names a Space, and so needs somebody who is in it. */
function intoASpace(deps: ApprovalApi) {
  return api<{ Variables: Signed & InSpace }>().openapiRoutes([approving(deps), makingAKey(deps)])
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

/** Saying yes. */
function approving(deps: ApprovalApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      // The Space is in the path, not the body: approving is something you do *to a Space*, and
      // the same gate that guards every other route about one then guards this.
      path: '/spaces/{slug}/enrolments/{userCode}/approve',
      summary: 'Let that machine into this Space',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), userCode: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('It may come in'),
        404: refusal('Nothing is waiting under that code, or no such Space'),
      },
    }),

    handler: async (c) => {
      const userCode = readUserCode(c.req.valid('param').userCode)
      if (userCode === undefined) return c.json(body(NOT_WAITING), NOT_WAITING.status)

      const answered = await approveEnrolment(deps.db, userCode, {
        userId: c.get('userId'),
        spaceId: c.get('space').id,
      })
      if (answered.kind === 'not-waiting') return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.body(null, 204)
    },
  })
}

/**
 * Saying yes in advance: an enrolment that arrives approved.
 *
 * Not a second mechanism. Somebody standing in a Space, generating one, has already made the
 * decision the code path asks a person to make — so the row is written with that decision on it,
 * and the machine that presents it skips only the waiting.
 *
 * For a machine with no browser to open, which is most machines that are not somebody's laptop.
 */
function makingAKey(deps: ApprovalApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      path: '/spaces/{slug}/machine-keys',
      summary: 'Make a key a machine can come in with, without anybody approving it later',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        201: sends(keyBody, 'The key, shown this once and never again'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      const secret = newEnrolmentSecret()

      // A key: no code and no machine name, because nobody will read one and nobody knows the
      // other yet. Which of those an enrolment has is the shape, not four fields left blank.
      const opened = await openEnrolment(deps.db, {
        kind: 'key',
        secretHash: secret.hash,
        spaceId: c.get('space').id,
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
