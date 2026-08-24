/**
 * The things that open an account.
 *
 * An address proved by a code and a provider account proved by a handshake are one concept: each
 * is a credential, each carries the same weight, and either opens the same door. They were once two
 * ideas here, because the account *was* its address and so the address could not be "connected".
 * The account is an id now, so that difference is gone and nothing is left to keep them apart.
 */

import { normalizeEmail } from './email-address.ts'
import { PROVIDERS, type Provider } from './provider.ts'

export const CREDENTIAL_KINDS = ['email', ...PROVIDERS] as const

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** One of them. `subject` is the address, or the provider's own id for somebody — never their address. */
export type Credential = {
  readonly kind: CredentialKind
  readonly subject: string
}

/**
 * The one form a credential is written and looked up in. The two rules are opposites and that is the
 * whole reason this exists: an address is folded, because otherwise one person becomes two
 * accounts; a provider's id is copied exactly, because it is theirs and not ours to reshape.
 */
export function canonical(credential: Credential): Credential {
  return credential.kind === 'email'
    ? { kind: 'email', subject: normalizeEmail(credential.subject) }
    : credential
}

/**
 * What a stranger can use here, which is a different question from what an account holds: nobody
 * holds anything yet, and the emailed code is offered to everyone because anyone can prove an
 * address. Only a provider this deployment has keys for is worth showing.
 */
export function offeredKinds(offered: Iterable<Provider>): readonly CredentialKind[] {
  const available = new Set(offered)
  return ['email', ...PROVIDERS.filter((kind) => available.has(kind))]
}

/**
 * One row of what the account screen shows.
 *
 * An address is only ever ready — it is here because somebody proved it. A provider is ready, or
 * it is something to connect, and there is no third state to invent. A `connectable` row is not
 * yet a credential; it is the offer to make one, and it belongs on this list because the list
 * answers "how do I get in", not "what does the table hold".
 */
export type Shown =
  | { readonly kind: 'email'; readonly address: string; readonly state: 'ready' }
  | { readonly kind: Provider; readonly state: 'ready' | 'connectable' }

/**
 * Read, never stored. What is true is which credentials this account holds; this is a reading of
 * that, so there is no "which ways does this account support" state that could drift from the rows.
 *
 * Addresses are listed one by one rather than folded into a single "emailed code" line. Folded,
 * nobody can see how many there are — and how many there are is the entire reason this screen
 * exists.
 *
 * A provider this deployment has no keys for is not offered, because that door opens onto an
 * error. One already held still shows even if the keys were taken away, since taking it off the
 * list would leave somebody wondering how they got in.
 */
export function shown(held: readonly Credential[], offered: Iterable<Provider>): readonly Shown[] {
  const linked = new Set(held.map((credential) => credential.kind))
  const available = new Set(offered)

  return [
    ...held
      .filter((credential) => credential.kind === 'email')
      .map(
        (credential) => ({ kind: 'email', address: credential.subject, state: 'ready' }) as const,
      ),
    ...PROVIDERS.filter((kind) => available.has(kind) || linked.has(kind)).map(
      (kind) => ({ kind, state: linked.has(kind) ? 'ready' : 'connectable' }) as const,
    ),
  ]
}
