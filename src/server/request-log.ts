/**
 * Giving every request a name, and saying afterwards what became of it.
 *
 * The name goes out in a header too, so a person reporting a problem can quote the one string
 * that finds their request among all the instances.
 */

import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { routePath } from 'hono/route'
import type { Log } from '../log.ts'

export const REQUEST_ID_HEADER = 'X-Request-Id'

export type Logged = { log: Log }

export function requestLog(log: Log) {
  return createMiddleware<{ Variables: Logged }>(async (c, next) => {
    const requestId = randomUUID()
    c.set('log', log.child({ requestId }))
    c.header(REQUEST_ID_HEADER, requestId)

    const started = performance.now()
    await next()

    // The pattern, not the path: `/spaces/:slug` groups, `/spaces/徐悦泰` does not, and the second
    // one puts somebody's Space name in a log that outlives the request by months.
    c.get('log').info(
      {
        method: c.req.method,
        route: routePath(c),
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    )
  })
}
