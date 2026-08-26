/**
 * Serving the built browser app from this process.
 *
 * One origin for the page and the API, and that is forced rather than chosen: the page's calls
 * carry no origin of their own, and its session cookie is `SameSite=Lax`. Served from somewhere
 * else, every call would be cross-site and every one of them would arrive signed out.
 *
 * A deployment may still put a proxy or a CDN in front of the pages instead — then it leaves
 * `WEB_ROOT` unset and none of this mounts. What is not allowed is a second origin.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, MiddlewareHandler } from 'hono'

/** Everything the build writes under this name carries a hash of its contents; nothing else does. */
export const HASHED = '/assets/*'

const FOREVER = 'public, max-age=31536000, immutable'

/**
 * Files whose names carry their own hash, kept for as long as any browser likes.
 *
 * A change to one of these is a new name, so nothing that is still being asked for can be stale.
 * It is the other half of {@link THE_PAGE}, and only safe because of it.
 */
export function hashedFiles(root: string): MiddlewareHandler {
  const files = serveStatic({ root })

  return async (c, next) => {
    // Set on the way back rather than through `onFound`, which is measured: that hook is called
    // after the response has already been built, so a header set in it never reaches anybody.
    const served = await files(c, next)
    if (served === undefined) return undefined

    served.headers.set('Cache-Control', FOREVER)
    return served
  }
}

/**
 * The one file whose name never changes, and therefore the one that must never be kept.
 *
 * It is what names the hashed files. Cached, a browser goes on asking for the assets of a build
 * that is no longer deployed, and renders a page nobody can reproduce.
 */
const THE_PAGE = 'no-cache'

/**
 * Whether this request is a browser asking for a page.
 *
 * The one honest way to tell somebody's address bar from a client calling an endpoint that does
 * not exist: a navigation says it accepts HTML and a call for JSON does not. Both get answered,
 * with different things — the app for the first, a refusal it can read for the second.
 */
export function wantsAPage(c: Context): boolean {
  return c.req.header('accept')?.includes('text/html') === true
}

/**
 * The app itself, for any address it owns.
 *
 * Which addresses those are is the page's to know, not this server's: the routing lives over
 * there. So every address that is not one of ours is handed to the app, including the ones it
 * will itself call unknown — and handed over as a page with a 200, because nothing is missing.
 * The app is what lives at that address.
 *
 * Nothing when the file is not there. A deployment pointed at the wrong directory should not
 * answer every request with an empty page for the rest of its life.
 */
export function thePage(root: string) {
  return async (c: Context): Promise<Response | undefined> => {
    const html = await readFile(join(root, 'index.html'), 'utf8').catch(() => undefined)
    if (html === undefined) return undefined

    return c.html(html, 200, { 'Cache-Control': THE_PAGE })
  }
}
