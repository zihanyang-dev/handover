/**
 * Where a browser is sent back to after leaving for a provider.
 *
 * Whatever asked for the trip chose this, and by the time it is used it has been through a site we
 * do not control. An absolute URL here is an open redirect: a link that starts on our domain,
 * carries our name through a sign-in, and lands on somebody else's page asking for a password.
 */

const HOME = '/'

/** Keeps only a path on this site. Anything else becomes the front door. */
export function returnPath(asked: string | undefined): string {
  if (asked === undefined || !asked.startsWith('/')) return HOME
  // `//host` and `/\host` are how a browser reads a protocol-relative URL: still another origin.
  if (asked.startsWith('//') || asked.startsWith('/\\')) return HOME
  return asked
}
