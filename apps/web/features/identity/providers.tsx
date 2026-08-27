/**
 * Who else can vouch for somebody, and how each is shown.
 *
 * The names come from the contract rather than being written here, so a provider this deployment
 * learns about is a compile error until somebody gives it a label and a mark — not a button that
 * reads `undefined`, and not one that quietly never appears. Both screens that offer a way in read
 * this, because two copies of a list of two is how one of them ends up with three.
 */

import type { ReactElement } from 'react'
import type { components } from '../../generated/api.ts'
import { GitHubMark, GoogleMark } from './provider-marks.tsx'

/** Everything a stranger can use to get in, minus the one that is not a provider. */
export type Provider = Exclude<
  components['schemas']['OfferedCredentials']['offered'][number],
  'email'
>

export const PROVIDERS: Record<Provider, { readonly label: string; readonly icon: ReactElement }> =
  {
    google: { label: 'Google', icon: <GoogleMark /> },
    github: { label: 'GitHub', icon: <GitHubMark /> },
  }

export function isProvider(kind: string): kind is Provider {
  return kind in PROVIDERS
}
