/**
 * What happens when there is more than one server.
 *
 * Two pools are two processes as far as Postgres is concerned: separate connections, no shared
 * memory, nothing either one can tell the other. Anything that survives this survives a fleet.
 */

import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { hashCode } from '../identity/email-code.ts'
import { newSessionToken } from '../identity/session.ts'
import { userHolding, revokeSession } from './session.ts'
import { connect, type Database } from './connection.ts'
import { issueCode } from './email-code.ts'
import { signInWithCode } from './sign-in.ts'
import { arrive } from './user.ts'
import { createSpace } from './space.ts'
import { connectProvider } from './credential.ts'
import { openConversation, sayTo } from './conversation.ts'
import { takeOne } from './turn.ts'
import { openEnrolment, approveEnrolment } from './enrolment.ts'
import { checkIn, collectEnrolment } from './machine.ts'
import { newEnrolmentSecret } from '../machine/secret.ts'
import { hashSecret } from '../secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { normalizeSlug } from '@handover/universal'
import type { Slug } from '@handover/universal'

const env = loadEnv()

/** Room enough that no test here trips the per-caller limit. */
const ROOM = 1000
const one: Database = connect(env)
const two: Database = connect(env)

/** A fresh address per test, so no test depends on the database being empty when it starts. */
/** A request key is unique per asker, so a fresh one per test keeps them out of each other's way. */
let RUN = ''
let EMAIL = ''

beforeEach(() => {
  RUN = randomUUID()
  EMAIL = `mina-${randomUUID()}@example.com`
})
const CODE = '493018'

afterAll(async () => {
  await Promise.all([one.destroy(), two.destroy()])
})

describe('two instances at once', () => {
  it('send one mail between them when the same request reaches both', async () => {
    const request = {
      requestKey: `${RUN}-k1`,
      email: EMAIL,
      purpose: 'sign-in' as const,
      codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
      askedBy: null,
    }

    const [a, b] = await Promise.all([issueCode(one, request, ROOM), issueCode(two, request, ROOM)])

    expect([a.kind, b.kind].sort()).toEqual(['issued', 'replayed'])
    expect(
      await one.selectFrom('email_codes').select('id').where('email', '=', EMAIL).execute(),
    ).toHaveLength(1)
  })

  it('let exactly one of them create a Space with a given name', async () => {
    const person = await one
      .transaction()
      .execute(async (tx) =>
        arrive(
          tx,
          { kind: 'email', subject: EMAIL },
          { name: null, username: null, address: EMAIL },
        ),
      )
    const asked = {
      userId: person.userId,
      displayName: 'Acme',
      slug: `acme-${RUN.slice(0, 8)}` as Slug,
    }

    const [a, b] = await Promise.all([
      createSpace(one, { ...asked, requestKey: `${RUN}-r1` }),
      createSpace(two, { ...asked, requestKey: `${RUN}-r2` }),
    ])

    expect([a.kind, b.kind].sort()).toEqual(['created', 'slug-taken'])
  })

  it('let exactly one of them spend a code', async () => {
    const opened = await issueCode(
      one,
      {
        purpose: 'sign-in',
        requestKey: `${RUN}-k1`,
        email: EMAIL,
        codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
        askedBy: null,
      },
      ROOM,
    )
    if (opened.kind !== 'issued')
      throw new Error(`the fixture could not get a code: ${opened.kind}`)

    const attempt = { codeId: opened.id, submittedCode: CODE }
    const [a, b] = await Promise.all([
      signInWithCode(one, env.AUTH_SECRET, {
        ...attempt,
        sessionTokenHash: newSessionToken().hash,
      }),
      signInWithCode(two, env.AUTH_SECRET, {
        ...attempt,
        sessionTokenHash: newSessionToken().hash,
      }),
    ])

    // One session, not two: a code that let two browsers in would be a code used twice.
    expect([a.kind, b.kind].sort()).toEqual(['rejected', 'signed-in'])
    expect(
      await one
        .selectFrom('browser_sessions')
        .innerJoin('credentials', 'credentials.user_id', 'browser_sessions.user_id')
        .select('browser_sessions.id')
        .where('credentials.subject', '=', EMAIL)
        .execute(),
    ).toHaveLength(1)
  })

  it('honour a session the other one issued', async () => {
    const opened = await issueCode(
      one,
      {
        purpose: 'sign-in',
        requestKey: `${RUN}-k1`,
        email: EMAIL,
        codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
        askedBy: null,
      },
      ROOM,
    )
    if (opened.kind !== 'issued')
      throw new Error(`the fixture could not get a code: ${opened.kind}`)
    const token = newSessionToken()
    await signInWithCode(one, env.AUTH_SECRET, {
      codeId: opened.id,
      submittedCode: CODE,
      sessionTokenHash: token.hash,
    })

    expect(await userHolding(two, token.hash)).toBeDefined()
  })

  it('stop honouring it the moment the other one revokes it', async () => {
    const opened = await issueCode(
      one,
      {
        purpose: 'sign-in',
        requestKey: `${RUN}-k1`,
        email: EMAIL,
        codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
        askedBy: null,
      },
      ROOM,
    )
    if (opened.kind !== 'issued')
      throw new Error(`the fixture could not get a code: ${opened.kind}`)
    const token = newSessionToken()
    await signInWithCode(one, env.AUTH_SECRET, {
      codeId: opened.id,
      submittedCode: CODE,
      sessionTokenHash: token.hash,
    })

    await revokeSession(one, token.hash)

    // No cache to go stale. This is the whole reason sessions are not kept anywhere else.
    expect(await userHolding(two, token.hash)).toBeUndefined()
  })

  it('tell the loser of a connect race that it did not connect', async () => {
    // Both instances read nothing, both try to write, and the unique index picks one. Reporting
    // the loser as connected would show a way in that is not there — and on a second account,
    // that way in belongs to somebody else.
    const subject = `google-${RUN}`
    const mina = await someone(`mina-${RUN}@example.com`)
    const other = await someone(`other-${RUN}@example.com`)
    const identity = {
      provider: 'google',
      subject,
      verifiedEmail: EMAIL,
      name: null,
      username: null,
    } as const

    const [first, second] = await Promise.all([
      connectProvider(one, mina, identity),
      connectProvider(two, other, identity),
    ])

    const outcomes = [first.kind, second.kind].sort()
    expect(outcomes).toEqual(['connected', 'rejected'])
  })

  it('let exactly one of two instances take the same turn', async () => {
    // The whole reason the ledger exists. Two processes holding the same machine credential both
    // poll, both see the same unanswered question, and without the database deciding, both run it
    // — two agents in one directory, doing the same work twice.
    const { machineId, conversationId } = await aQuestion()

    const [first, second] = await Promise.all([takeOne(one, machineId), takeOne(two, machineId)])

    const took = [first, second].filter((taken) => taken !== undefined)
    expect(took).toHaveLength(1)
    expect(took[0]?.conversationId).toBe(conversationId)
  })

  it('let exactly one of them take *any* turn on one machine, not one turn each', async () => {
    // The harder half, and the one a primary key does not catch: two conversations waiting on the
    // same machine. Each instance reads "nothing open on this machine" in its own snapshot, then
    // claims a different conversation — two rows, no key in common, and two agents running in one
    // directory. prd 04 says a machine does exactly one thing at once, and this is where that has
    // to be decided.
    const { machineId, spaceId } = await aQuestion()
    await aSecondQuestion(machineId, spaceId)

    const [first, second] = await Promise.all([takeOne(one, machineId), takeOne(two, machineId)])

    expect([first, second].filter((taken) => taken !== undefined)).toHaveLength(1)
  })
})

/** A machine in a Space, a conversation on it, and one question nobody has answered. */
async function aQuestion(): Promise<{
  machineId: string
  conversationId: string
  spaceId: string
}> {
  const userId = await someone('asking')
  const made = await createSpace(one, {
    requestKey: `${RUN}-space`,
    userId,
    displayName: `Acme ${RUN.slice(0, 6)}`,
    slug: normalizeSlug(`Acme ${RUN.slice(0, 6)}`) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')

  const secret = newEnrolmentSecret()
  const userCode = newUserCode()
  await openEnrolment(one, {
    kind: 'asking',
    machineName: 'mina-mbp',
    secretHash: secret.hash,
    userCode,
  })
  await approveEnrolment(one, userCode, { userId })
  const collected = await collectEnrolment(one, {
    secretHash: secret.hash,
    tokenHash: hashSecret(`hm_${randomUUID()}`),
    machineName: 'mina-mbp',
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')
  await checkIn(one, collected.machineId, {
    version: undefined,
    found: [{ kind: 'claude-code', version: '2.1.231' }],
  })

  const conversation = await openConversation(one, {
    spaceId: made.space.id,
    machineId: collected.machineId,
    agentKind: 'claude-code',
  })
  if (conversation.kind !== 'opened') throw new Error('the fixture could not open a conversation')

  const said = await sayTo(
    one,
    { conversationId: conversation.conversationId, spaceId: made.space.id, key: `${RUN}-turn` },
    { text: 'take your time' },
  )
  if (said.kind !== 'said') throw new Error('the fixture could not ask')

  return {
    machineId: collected.machineId,
    conversationId: conversation.conversationId,
    spaceId: made.space.id,
  }
}

/** A second conversation on the same machine, with its own unanswered question. */
async function aSecondQuestion(machineId: string, spaceId: string): Promise<string> {
  const opened = await openConversation(one, { spaceId, machineId, agentKind: 'claude-code' })
  if (opened.kind !== 'opened') throw new Error('the fixture could not open a second conversation')

  const said = await sayTo(
    one,
    { conversationId: opened.conversationId, spaceId, key: `${RUN}-turn-2` },
    { text: 'and this one too' },
  )
  if (said.kind !== 'said') throw new Error('the fixture could not ask a second time')

  return opened.conversationId
}

/** An account, made the way arriving makes one. */
async function someone(address: string): Promise<string> {
  const arrived = await one
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )
  return arrived.userId
}
