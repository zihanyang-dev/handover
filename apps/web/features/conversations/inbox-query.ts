import { cached } from '../../api.ts'

/** Everything waiting on you, across every Space. */
export function inbox() {
  return cached.queryOptions(
    'get',
    '/me/inbox',
    {},
    {
      // Often enough that somebody who leaves this open sees a piece of work stop on them, rarely
      // enough to be free. Nothing pushes here: an Inbox is read when somebody wonders, not
      // watched.
      refetchInterval: 15_000,
      select: (answer) => answer.waiting,
    },
  )
}
