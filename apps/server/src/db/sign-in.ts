/**
 * Turning a proof into a browser session.
 *
 * Both ways in end here, so whatever was proved — an address by a code, or a provider account by
 * a handshake — becomes a session the same way, through the same lookup, with the same rules
 * about which account it reaches.
 *
 * Locks, in the order every path here takes them:
 *   1. the code row, for update, on the emailed-code path
 *   2. the advisory lock on the address, inside `arrive`
 *   3. the `credentials` row for the key, via its unique index
 *
 * Spending the code and creating the session are one transaction on purpose. Split them and a
 * crash in between leaves the person holding a code the system will now call already used, with
 * nothing they can do next that works.
 */

import type { Rejection } from '../identity/email-code.ts'
import type { ProviderIdentity } from '../identity/provider.ts'
import type { Credential } from '../identity/credential.ts'
import { openSession } from './session.ts'
import type { Database } from './connection.ts'
import { spendCode } from './email-code.ts'
import { arrive } from './user.ts'

export type SignInAttempt = {
  readonly codeId: string
  readonly submittedCode: string
  /** The hash of the token that will go to the browser. The token itself never comes here. */
  readonly sessionTokenHash: string
}

export type SignIn =
  | {
      readonly kind: 'signed-in'
      readonly userId: string
      readonly merged: boolean
    }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }

export async function signInWithCode(
  db: Database,
  secret: string,
  attempt: SignInAttempt,
): Promise<SignIn> {
  return db.transaction().execute(async (tx) => {
    const spent = await spendCode(tx, secret, {
      purpose: 'sign-in',
      codeId: attempt.codeId,
      code: attempt.submittedCode,
    })
    if (spent.kind === 'rejected') return { kind: 'rejected', rejection: spent.rejection }

    // The key is the address itself, so there is nothing else it could reach. The display name
    // has no provider to come from and falls to the address.
    const credential: Credential = { kind: 'email', subject: spent.address }
    const arrived = await arrive(tx, credential, {
      name: null,
      username: null,
      address: spent.address,
    })

    await openSession(tx, arrived.userId, attempt.sessionTokenHash)

    return { kind: 'signed-in', userId: arrived.userId, merged: arrived.merged }
  })
}

export type ProviderSignIn = {
  readonly userId: string
  readonly merged: boolean
}

/** Always signs somebody in: a verified address is the whole of what it takes to be somebody. */
export async function signInWithProvider(
  db: Database,
  identity: ProviderIdentity,
  sessionTokenHash: string,
): Promise<ProviderSignIn> {
  const credential: Credential = { kind: identity.provider, subject: identity.subject }

  return db.transaction().execute(async (tx) => {
    const arrived = await arrive(tx, credential, {
      name: identity.name,
      username: identity.username,
      address: identity.verifiedEmail,
    })

    await openSession(tx, arrived.userId, sessionTokenHash)

    return { userId: arrived.userId, merged: arrived.merged }
  })
}
