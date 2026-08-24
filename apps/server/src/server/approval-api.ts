/**
 * What a person does about a machine asking to come in: look at it, say yes, say no.
 *
 * Every route here is behind a live session, and saying yes needs more than that: it needs
 * membership of the Space being joined. That membership is the whole of somebody's standing to
 * let a machine in.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { approveEnrolment, enrolmentWaiting, refuseEnrolment } from '../db/enrolment.ts'
import { readUserCode } from '../machine/user-code.ts'
import { api, saysNothing, sends } from './contract.ts'
import { body, refusal, type Failure } from './failure.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type ApprovalApi = { readonly db: Database }

/** No enrolment is waiting under that code: never was, already answered, or ran out. */
const NOT_WAITING: Failure<404> = { reason: 'no-enrolment', recovery: 'start-over', status: 404 }

const waitingBody = z
  .object({ machineName: z.string(), expiresAt: z.iso.datetime() })
  .openapi('MachineWaiting')

const whatIsWaiting = createRoute({
  method: 'get',
  path: '/enrolments/{userCode}',
  summary: 'What is asking to come in under this code',
  request: { params: z.object({ userCode: z.string() }) },
  responses: {
    200: sends(waitingBody, 'A machine is waiting on an answer'),
    401: refusal('Nobody is signed in here'),
    404: refusal('Nothing is waiting under that code'),
  },
})

const approve = createRoute({
  method: 'post',
  // The Space is in the path, not the body: approving is something you do *to a Space*, and the
  // same gate that guards every other route about one then guards this.
  path: '/spaces/{slug}/enrolments/{userCode}/approve',
  summary: 'Let that machine into this Space',
  request: { params: z.object({ slug: z.string(), userCode: z.string() }) },
  responses: {
    204: saysNothing('It may come in'),
    401: refusal('Nobody is signed in here'),
    404: refusal('Nothing is waiting under that code, or no such Space'),
  },
})

const refuse = createRoute({
  method: 'post',
  path: '/enrolments/{userCode}/refuse',
  summary: 'Turn that machine away',
  request: { params: z.object({ userCode: z.string() }) },
  responses: {
    204: saysNothing('It may not come in, and asking again will not change that'),
    401: refusal('Nobody is signed in here'),
    404: refusal('Nothing is waiting under that code'),
  },
})

export function approvalApi(deps: ApprovalApi) {
  const signedIn = requireSession(deps.db)
  const inSpace = [signedIn, requireMember(deps.db)]

  return api<{ Variables: Signed & InSpace }>()
    .openapi({ ...whatIsWaiting, middleware: [signedIn] }, async (c) => {
      const userCode = readUserCode(c.req.valid('param').userCode)
      const waiting = userCode === undefined ? undefined : await enrolmentWaiting(deps.db, userCode)

      if (waiting === undefined) return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.json(
        { machineName: waiting.machineName, expiresAt: waiting.expiresAt.toISOString() },
        200,
      )
    })

    .openapi({ ...approve, middleware: inSpace }, async (c) => {
      const userCode = readUserCode(c.req.valid('param').userCode)
      if (userCode === undefined) return c.json(body(NOT_WAITING), NOT_WAITING.status)

      const answered = await approveEnrolment(deps.db, userCode, {
        userId: c.get('userId'),
        spaceId: c.get('space').id,
      })
      if (answered.kind === 'not-waiting') return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.body(null, 204)
    })

    .openapi({ ...refuse, middleware: [signedIn] }, async (c) => {
      const userCode = readUserCode(c.req.valid('param').userCode)
      const answered =
        userCode === undefined
          ? ({ kind: 'not-waiting' } as const)
          : await refuseEnrolment(deps.db, userCode)

      if (answered.kind === 'not-waiting') return c.json(body(NOT_WAITING), NOT_WAITING.status)

      return c.body(null, 204)
    })
}
