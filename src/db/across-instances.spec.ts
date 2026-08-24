/**
 * What happens when there is more than one server.
 *
 * Two pools are two processes as far as Postgres is concerned: separate connections, no shared
 * memory, nothing either one can tell the other. Anything that survives this survives a fleet.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { hashCode } from '../identity/emailed-code.ts'
import { newSessionToken } from '../identity/browser-session.ts'
import { userHolding, revokeSession } from './browser-session.ts'
import { connect, type Database } from './connection.ts'
import { openChallenge } from './email-challenge.ts'
import { signIn } from './sign-in.ts'
import { createSpace } from './space.ts'
import type { Slug } from '../space/slug.ts'

const env = loadEnv()
const one: Database = connect(env)
const two: Database = connect(env)

const EMAIL = 'mina@example.com'
const CODE = '493018'

afterAll(async () => {
  await Promise.all([one.destroy(), two.destroy()])
})

describe('two instances at once', () => {
  it('send one mail between them when the same request reaches both', async () => {
    const request = {
      requestKey: 'k1',
      email: EMAIL,
      codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
    }

    const [a, b] = await Promise.all([openChallenge(one, request), openChallenge(two, request)])

    expect([a.kind, b.kind].sort()).toEqual(['opened', 'replayed'])
    expect(await one.selectFrom('email_challenges').select('id').execute()).toHaveLength(1)
  })

  it('let exactly one of them create a Space with a given name', async () => {
    const person = await one
      .insertInto('users')
      .values({ verified_email: EMAIL, display_name: EMAIL })
      .returning('id')
      .executeTakeFirstOrThrow()
    const asked = { userId: person.id, displayName: 'Acme', slug: 'acme' as Slug }

    const [a, b] = await Promise.all([
      createSpace(one, { ...asked, requestKey: 'r1' }),
      createSpace(two, { ...asked, requestKey: 'r2' }),
    ])

    expect([a.kind, b.kind].sort()).toEqual(['created', 'slug-taken'])
  })

  it('let exactly one of them spend a code', async () => {
    const opened = await openChallenge(one, {
      requestKey: 'k1',
      email: EMAIL,
      codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
    })
    if (opened.kind === 'too-soon') throw new Error('the fixture asked for codes too fast')

    const attempt = { challengeId: opened.id, submittedCode: CODE }
    const [a, b] = await Promise.all([
      signIn(one, env.AUTH_SECRET, { ...attempt, sessionTokenHash: newSessionToken().hash }),
      signIn(two, env.AUTH_SECRET, { ...attempt, sessionTokenHash: newSessionToken().hash }),
    ])

    // One session, not two: a code that let two browsers in would be a code used twice.
    expect([a.kind, b.kind].sort()).toEqual(['rejected', 'signed-in'])
    expect(await one.selectFrom('browser_sessions').select('id').execute()).toHaveLength(1)
  })

  it('honour a session the other one issued', async () => {
    const opened = await openChallenge(one, {
      requestKey: 'k1',
      email: EMAIL,
      codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
    })
    if (opened.kind === 'too-soon') throw new Error('the fixture asked for codes too fast')
    const token = newSessionToken()
    await signIn(one, env.AUTH_SECRET, {
      challengeId: opened.id,
      submittedCode: CODE,
      sessionTokenHash: token.hash,
    })

    expect(await userHolding(two, token.hash)).toBeDefined()
  })

  it('stop honouring it the moment the other one revokes it', async () => {
    const opened = await openChallenge(one, {
      requestKey: 'k1',
      email: EMAIL,
      codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
    })
    if (opened.kind === 'too-soon') throw new Error('the fixture asked for codes too fast')
    const token = newSessionToken()
    await signIn(one, env.AUTH_SECRET, {
      challengeId: opened.id,
      submittedCode: CODE,
      sessionTokenHash: token.hash,
    })

    await revokeSession(one, token.hash)

    // No cache to go stale. This is the whole reason sessions are not kept anywhere else.
    expect(await userHolding(two, token.hash)).toBeUndefined()
  })
})
