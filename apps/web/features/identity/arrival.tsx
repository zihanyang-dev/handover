/**
 * What a trip through a provider left behind, said once on arrival.
 *
 * One home for these words: the sign-in purpose lands on onboarding, the connect purpose on the
 * account page, and both trips can end the same ways. A trip that failed and said nothing looks
 * exactly like a button that does nothing.
 */

import { CheckCircleFill, ExclamationCircleFill } from 'react-bootstrap-icons'

const WENT_WRONG: Record<string, string> = {
  cancelled: 'Nothing was connected, and nothing changed.',
  expired: 'That took too long. Try connecting it again.',
  'no-verified-email': 'That account has no confirmed address, so it cannot be used here.',
  'linked-elsewhere': 'That account is already connected to a different Handover account.',
  'already-connected': 'You already have one of those connected.',
}

export function Arrival({ result }: { readonly result: string | undefined }) {
  const wentWrong = result === undefined ? undefined : WENT_WRONG[result]

  return (
    <>
      {result === 'merged' && (
        <p className="said said-good">
          <CheckCircleFill aria-hidden />
          You already had an account here. This way of signing in now reaches the same one.
        </p>
      )}

      {wentWrong !== undefined && (
        <p className="said said-bad">
          <ExclamationCircleFill aria-hidden />
          {wentWrong}
        </p>
      )}
    </>
  )
}
