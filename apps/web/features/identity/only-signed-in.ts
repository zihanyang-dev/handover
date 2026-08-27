/**
 * A screen that needs somebody signed in, and remembers where they were.
 *
 * Said once, here, because every screen behind a session needs the same two things and getting
 * either wrong is invisible: a route with no guard folds "nobody is signed in" into whatever its
 * own missing-thing answer is, and a guard with no `next` sends somebody who came for one Space to
 * the front door and leaves them to find it again.
 */

import { returnPath } from '@handover/universal'
import { redirect } from '@tanstack/react-router'
import { cache } from '../../query-client.ts'
import { meQuery, NotSignedIn } from './me.ts'

export async function onlySignedIn(at: { readonly href: string }): Promise<void> {
  // Through the cache, so what this reads on the way in is what the screen behind it renders from.
  // Read and thrown away, every protected screen asks the same question twice and shows its empty
  // state during the second ask.
  const asked = await cache.query(meQuery).then(
    () => undefined,
    (trouble: unknown) => trouble,
  )

  // Anything else — a server that broke, a network that went — is not "sign in again". The screen
  // says so itself; sending somebody to sign in would be this guard guessing.
  if (!(asked instanceof NotSignedIn)) return

  // Through `returnPath` even though it came from this browser's own address bar: what is put in
  // it next is a redirect, and the one rule about a redirect is that it stays on this site.
  throw redirect({
    to: '/sign-in',
    search: { next: returnPath(at.href, globalThis.location.origin) },
  })
}
