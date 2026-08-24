/**
 * Which ways lead into an account.
 *
 * Read, never stored. What is true is which providers this account has linked; this is a reading
 * of that fact, so there is no "which methods does this account support" state to keep correct.
 *
 * The emailed code is always ready because the account *is* the address. There is nothing to
 * connect, and — the part that matters — nothing that could ever disconnect it and lock somebody
 * out of their own account.
 */

import { PROVIDERS, type Provider } from './provider.ts'

export type Way = {
  readonly kind: Provider | 'email-code'
  readonly state: 'ready' | 'connectable'
}

/**
 * A provider this deployment has not been given keys for is not a way in, and listing it would
 * offer somebody a door that opens onto an error. One already connected still shows: taking it
 * off the list would leave them wondering how they got here.
 */
export function waysIn(connected: Iterable<Provider>, offered: Iterable<Provider>): readonly Way[] {
  const linked = new Set(connected)
  const available = new Set(offered)

  return [
    { kind: 'email-code', state: 'ready' },
    ...PROVIDERS.filter((kind) => available.has(kind) || linked.has(kind)).map((kind) => ({
      kind,
      state: linked.has(kind) ? ('ready' as const) : ('connectable' as const),
    })),
  ]
}
