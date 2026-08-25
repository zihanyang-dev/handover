/**
 * Where a browser is sent back to after being sent away.
 *
 * Both sides have to agree, which is why it lives here. The server uses it for the round trip
 * through a provider; the page uses it for the address it remembered while somebody signed in
 * again. Whatever asked for it chose it, and by the time it is used it has been through a site we
 * do not control — or through the address bar. An absolute URL here is an open redirect: a link
 * that starts on our domain, carries our name through a sign-in, and lands on somebody else's page
 * asking for a password.
 */

const HOME = '/'

/**
 * Keeps only a path on this site. Anything else becomes the front door.
 *
 * Resolved against our own origin rather than inspected as text, because a browser does not read
 * it as text either: it strips tabs and newlines before parsing, so `/\t/evil.example/x` — which
 * starts with a slash and is not `//` — is `https://evil.example/x` to `new URL()`. Every check
 * written against the characters is a check the browser has already undone.
 *
 * What comes back is rebuilt from the parsed URL, so nothing survives that the parse did not
 * understand.
 */
export function returnPath(asked: string | undefined, origin: string): string {
  if (asked === undefined) return HOME

  const here = new URL(origin)
  const landing = URL.parse(asked, here.href)
  if (landing === null || landing.origin !== here.origin) return HOME

  return `${landing.pathname}${landing.search}${landing.hash}`
}
