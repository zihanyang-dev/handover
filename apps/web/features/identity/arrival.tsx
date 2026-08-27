/**
 * What a trip through a provider left behind, said once on arrival.
 *
 * One home for these words: the sign-in purpose lands on onboarding, the connect purpose on the
 * account page, and both trips can end the same ways. A trip that failed and said nothing looks
 * exactly like a button that does nothing.
 */

import { useQuery } from '@tanstack/react-query'
import { CheckCircleFill, ExclamationCircleFill } from 'react-bootstrap-icons'
import { meQuery } from './me.ts'

const WENT_WRONG: Record<string, string> = {
  cancelled: 'Nothing was connected, and nothing changed.',
  expired: 'That took too long. Try connecting it again.',
  'no-verified-email': 'That account has no confirmed address, so it cannot be used here.',
  'linked-elsewhere': 'That account is already connected to a different Handover account.',
  'already-connected': 'You already have one of those connected.',
}

/** How each way in is spelled to a person. The provider table owns the two that have marks. */
const NAMED: Record<string, string> = {
  email: 'an email address',
  google: 'Google',
  github: 'GitHub',
}

/**
 * The one time two ways in become one account, said in full.
 *
 * `prd.md` 01 ③: merging by a confirmed address is our choice, so it owes somebody the whole
 * picture — which way in the account started as, and how many now reach it. Told only that "you
 * already had an account", a person cannot tell whether they are in the one they meant.
 *
 * Read from `/me` rather than carried in the redirect: what is true of an account belongs to the
 * account, and a word passed through a URL is a word anybody can put there.
 */
function Merged() {
  const me = useQuery(meQuery)
  if (me.data === undefined) return null

  const ways = me.data.credentials.filter((one) => one.state === 'ready').length

  return (
    <p className="said said-good">
      <CheckCircleFill aria-hidden />
      You already had an account here — it was made with {NAMED[me.data.startedWith]}. This way of
      signing in now reaches the same one, so{' '}
      {ways === 1 ? 'there is 1 way' : `there are ${String(ways)} ways`} into it.
    </p>
  )
}

export function Arrival({ result }: { readonly result: string | undefined }) {
  const wentWrong = result === undefined ? undefined : WENT_WRONG[result]

  return (
    <>
      {result === 'merged' && <Merged />}

      {wentWrong !== undefined && (
        <p className="said said-bad">
          <ExclamationCircleFill aria-hidden />
          {wentWrong}
        </p>
      )}
    </>
  )
}
