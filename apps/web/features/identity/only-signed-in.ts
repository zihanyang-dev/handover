/**
 * A screen that needs somebody signed in, and remembers where they were.
 *
 * Said once, here, because every screen behind a session needs the same two things and getting
 * either wrong is invisible: a route with no guard folds "nobody is signed in" into whatever its
 * own missing-thing answer is, and a guard with no `next` sends somebody who came for one Space to
 * the front door and leaves them to find it again.
 */

import { redirect } from '@tanstack/react-router'
import { returnPath } from '@handover/universal'
import { api } from '../../api.ts'

export async function onlySignedIn(at: { readonly href: string }): Promise<void> {
  const { response } = await api.GET('/me')
  if (response.status !== 401) return

  // Through `returnPath` even though it came from this browser's own address bar: what is put in
  // it next is a redirect, and the one rule about a redirect is that it stays on this site.
  throw redirect({
    to: '/sign-in',
    search: { next: returnPath(at.href, globalThis.location.origin) },
  })
}
