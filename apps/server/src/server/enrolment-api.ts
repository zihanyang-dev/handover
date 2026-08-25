/**
 * What a machine does to get into a Space: ask, then collect.
 *
 * Neither needs a session. Asking does not, because a machine nobody has approved has no identity
 * to prove; collecting does not, because the secret handed back at the asking *is* the proof.
 * Nothing either of them does matters until a person says yes.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Env } from 'hono'
import type { Database } from '../db/connection.ts'
import { openEnrolment } from '../db/enrolment.ts'
import { collectEnrolment } from '../db/machine.ts'
import { AGENT_COMMANDS } from '../machine/agent-kind.ts'
import { POLL_SECONDS } from '../machine/presence.ts'
import { hashSecret, newEnrolmentSecret, newMachineToken } from '../machine/secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { api, endpointsBehind, sends, takes } from './contract.ts'
import { MALFORMED_BODY } from './failure.ts'

export type EnrolmentApi = {
  readonly db: Database
  /** Where the person doing the approving is sent. Printed by the machine, opened by them. */
  readonly webOrigin: string
}

const asking = z
  .object({ machineName: z.string().min(1).max(200).openapi({ example: 'mina-mbp' }) })
  .openapi('AskToConnect')

const askedBody = z
  .object({
    /**
     * What this machine shows to collect its credential. Handed back once, here, so it never has
     * to be stored anywhere before it is worth anything.
     */
    secret: z.string(),
    userCode: z.string().openapi({ example: 'WDJB-MJHT' }),
    /** Where to go and type it. Short, because somebody may be typing it on a phone. */
    verifyUrl: z.url(),
    /** The same page with the code already in it, for anyone who can click rather than type. */
    verifyUrlComplete: z.url(),
    pollSeconds: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  })
  .openapi('AskedToConnect')

const collecting = z
  .object({
    secret: z.string().min(1).max(200),
    /** What this machine calls itself. Used only when nobody named it at approval. */
    machineName: z.string().min(1).max(200).openapi({ example: 'build-server-1' }),
  })
  .openapi('CollectEnrolment')

const collectedBody = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('granted'),
      token: z.string(),
      machineId: z.uuid(),
      /** So a machine knows what to look for before its first check-in, not 25 seconds after. */
      lookFor: z.array(z.string()).readonly(),
    }),
    z.object({ kind: z.literal('waiting') }),
    z.object({ kind: z.literal('refused') }),
    z.object({ kind: z.literal('expired') }),
    z.object({ kind: z.literal('spent') }),
    z.object({ kind: z.literal('no-enrolment') }),
  ])
  .openapi('Collected')

/**
 * Nobody, and that is the whole design of this file.
 *
 * A machine nobody has approved has no identity to prove, and the secret handed back at the
 * asking is the only proof collecting needs. Nothing either does matters until a person says yes.
 */
const anyone = endpointsBehind<Env>()

export function enrolmentApi(deps: EnrolmentApi) {
  return api().openapiRoutes([askingToConnect(deps), collecting_(deps)])
}

/** Asking to come in, which produces a code somebody has to say yes to. */
function askingToConnect(deps: EnrolmentApi) {
  return anyone({
    route: createRoute({
      method: 'post',
      path: '/enrolments',
      summary: 'Ask to bring this machine in, and get a code for somebody to approve',
      request: { body: takes(asking) },
      responses: { ...MALFORMED_BODY, 201: sends(askedBody, 'Show the code and start asking') },
    }),

    handler: async (c) => {
      const secret = newEnrolmentSecret()
      const userCode = newUserCode()

      const opened = await openEnrolment(deps.db, {
        spaceId: undefined,
        machineName: c.req.valid('json').machineName,
        secretHash: secret.hash,
        userCode,
        approvedBy: undefined,
      })

      return c.json(
        {
          secret: secret.secret,
          userCode,
          verifyUrl: `${deps.webOrigin}/connect`,
          verifyUrlComplete: `${deps.webOrigin}/connect/${userCode}`,
          pollSeconds: POLL_SECONDS,
          expiresAt: opened.expiresAt.toISOString(),
        },
        201,
      )
    },
  })
}

/** Collecting the credential, which is also how a machine asks whether it has been approved yet. */
function collecting_(deps: EnrolmentApi) {
  return anyone({
    route: createRoute({
      method: 'post',
      path: '/enrolments/collect',
      summary: 'Collect the credential this enrolment was approved for',
      request: { body: takes(collecting) },
      responses: {
        ...MALFORMED_BODY,
        200: sends(collectedBody, 'What became of it, including still waiting'),
      },
    }),

    handler: async (c) => {
      const token = newMachineToken()
      const asked = c.req.valid('json')
      const collected = await collectEnrolment(deps.db, {
        secretHash: hashSecret(asked.secret),
        tokenHash: token.hash,
        machineName: asked.machineName,
      })

      if (collected.kind === 'granted') {
        return c.json(
          {
            kind: 'granted' as const,
            token: token.secret,
            machineId: collected.machineId,
            lookFor: AGENT_COMMANDS,
          },
          200,
        )
      }

      // Still waiting is one of these, and the most common. It is not a failure, so it is not a
      // failure status — the machine reads the kind and decides whether to ask again.
      return c.json({ kind: collected.kind }, 200)
    },
  })
}
