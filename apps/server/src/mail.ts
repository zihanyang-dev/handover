/**
 * The only place that hands a letter to Resend.
 *
 * It does not know what a verification code is, and it does not write any of the words. What it
 * owns is the one thing this file is for: turning "did it go?" into an answer that is honest
 * about not knowing.
 */

import type { Env } from './env.ts'

const ENDPOINT = 'https://api.resend.com/emails'

/**
 * A request that never answers would hold the route open behind it. The letter is sent after the
 * code is committed, so giving up here costs nothing the person cannot fix by asking again.
 */
const GIVE_UP_AFTER_MS = 10_000

type Letter = {
  readonly to: string
  readonly subject: string
  readonly text: string
}

type Delivery = 'sent' | 'refused' | 'unknown'

export type Mailer = (letter: Letter) => Promise<Delivery>

/**
 * Never throws. A letter that failed to go must not take down a code that was committed and
 * works — the person can ask for another, and that is the whole recovery.
 */
export function resend(env: Env): Mailer {
  return async (letter) => {
    try {
      const answered = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: env.MAIL_FROM, ...letter }),
        signal: AbortSignal.timeout(GIVE_UP_AFTER_MS),
      })

      if (answered.ok) return 'sent'
      // Refused for a reason of ours — a malformed address, a sending domain not verified. The
      // letter definitely did not go.
      if (answered.status < 500) return 'refused'
      // Their side broke after taking the request. It may have gone out; we cannot say.
      return 'unknown'
    } catch {
      // Timed out, or the network never carried it. Same answer: nobody knows.
      return 'unknown'
    }
  }
}
