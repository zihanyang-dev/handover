/**
 * Turning a submitted emailed code into a browser session.
 *
 * Locks, in the order every path here takes them:
 *   1. the challenge row, for update
 *   2. the `users` row for the verified address, via its unique index
 *
 * Spending the code and creating the session are one transaction on purpose. Split them and a
 * crash in between leaves the person holding a code the system will now call already used, with
 * nothing they can do next that works.
 */

import { sql } from 'kysely'
import { verifyChallenge, type ClosedReason, type Rejection } from '../identity/emailed-code.ts'
import { openSession } from './browser-session.ts'
import type { Database } from './connection.ts'
import { personFor } from './user.ts'

export type SignInAttempt = {
  readonly challengeId: string
  readonly submittedCode: string
  /** The hash of the token that will go to the browser. The token itself never comes here. */
  readonly sessionTokenHash: string
}

export type SignIn =
  | { readonly kind: 'signed-in'; readonly userId: string; readonly sessionId: string }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }

export async function signIn(
  db: Database,
  secret: string,
  attempt: SignInAttempt,
): Promise<SignIn> {
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('email_challenges')
      .select(['email', 'code_hash', 'expires_at', 'attempts', 'closed_reason'])
      .where('id', '=', attempt.challengeId)
      .forUpdate()
      .executeTakeFirst()

    const challenge =
      row === undefined
        ? undefined
        : {
            email: row.email,
            codeHash: row.code_hash,
            expiresAt: row.expires_at,
            attempts: row.attempts,
            closedReason: row.closed_reason as ClosedReason | null,
          }

    const verdict = verifyChallenge(challenge, attempt.submittedCode, secret, new Date())

    if (verdict.kind === 'rejected') {
      // Only a wrong guess costs a try. The others are already final, and counting them would
      // burn the tries of somebody who is being told the challenge is over.
      if (verdict.rejection === 'code-mismatch') {
        await tx
          .updateTable('email_challenges')
          .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
          .where('id', '=', attempt.challengeId)
          .execute()
      }
      return { kind: 'rejected', rejection: verdict.rejection }
    }

    await tx
      .updateTable('email_challenges')
      .set({ closed_at: sql`now()`, closed_reason: 'consumed' })
      .where('id', '=', attempt.challengeId)
      .execute()

    // Nothing the provider path would not also do: a code proves an address, and that is all it
    // takes. The display name has no provider to come from, so it falls to the address itself.
    const userId = await personFor(tx, {
      name: null,
      username: null,
      verifiedEmail: verdict.verifiedEmail,
    })

    return {
      kind: 'signed-in',
      userId,
      sessionId: await openSession(tx, userId, attempt.sessionTokenHash),
    }
  })
}
