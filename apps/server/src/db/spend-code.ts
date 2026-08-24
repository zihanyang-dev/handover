/**
 * Spending an emailed code, inside whatever transaction is about to act on the proof.
 *
 * It takes the transaction rather than the database on purpose. Whatever the code proves an
 * address *for* has to commit with the spending: split them and a crash in between leaves
 * somebody holding a code the system now calls used, with nothing they can do next that works.
 */

import { sql } from 'kysely'
import {
  verifyChallenge,
  type ClosedReason,
  type Purpose,
  type Rejection,
} from '../identity/emailed-code.ts'
import type { Tx } from './connection.ts'

/** Which letter is being answered, and with what. */
export type Answer = {
  readonly purpose: Purpose
  readonly challengeId: string
  readonly code: string
}

export type Spent =
  | { readonly kind: 'proved'; readonly address: string }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }

export async function spendCode(tx: Tx, secret: string, answer: Answer): Promise<Spent> {
  const row = await tx
    .selectFrom('email_challenges')
    .select(['email', 'code_hash', 'expires_at', 'attempts', 'closed_reason'])
    .where('id', '=', answer.challengeId)
    // A code sent to sign in is not a code sent to add an address. Looked up without this, one
    // could be spent on the other, and somebody talked into forwarding a code would have handed
    // over the wrong thing entirely.
    .where('purpose', '=', answer.purpose)
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

  const verdict = verifyChallenge(challenge, answer.code, secret, new Date())

  if (verdict.kind === 'rejected') {
    // Only a wrong guess costs a try. The others are already final, and counting them would burn
    // the tries of somebody who is being told the challenge is over.
    if (verdict.rejection === 'code-mismatch') {
      await tx
        .updateTable('email_challenges')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', answer.challengeId)
        .execute()
    }
    return { kind: 'rejected', rejection: verdict.rejection }
  }

  await tx
    .updateTable('email_challenges')
    .set({ closed_at: sql`now()`, closed_reason: 'consumed' })
    .where('id', '=', answer.challengeId)
    .execute()

  return { kind: 'proved', address: verdict.verifiedEmail }
}
