/**
 * How a piece of work stops working, and what it says on the way.
 *
 * Written once, here, because it was written twice: `server/task-api.ts` held the shape a machine
 * sends and `db/task.ts` held the shape this side acts on, and the two had drifted — the same
 * field was `text` on the wire and `said` in the rows, so the route carried a three-branch
 * translation whose only job was to rename it. A concept with no module of its own gets a copy in
 * every module that needs it, and the copies disagree.
 */

import { z } from '@hono/zod-openapi'
import { ACTIVITY } from '../conversation/transcript.ts'

/** How a piece of work ended, in the words a person reads. */
export type Ending = 'done' | 'cannot'

/**
 * The agent stopping, and why, as a machine sends it.
 *
 * Three, and `working` is not among them: an agent can stop itself and can never start itself.
 * What starts it again is a person saying something, a piece of work it handed out coming back,
 * or the clock. **The union is the state machine**, so nothing has to explain it a second time.
 */
export const HowItStopped = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('wait'), question: z.string().min(1).max(4000) }),
    z.object({ state: z.literal('sleep'), until: z.iso.datetime() }),
    z.object({
      state: z.literal('done'),
      ending: z.enum(['done', 'cannot']),
      text: z.string().min(1).max(4000),
    }),
  ])
  .openapi('HowItStopped')

/**
 * The same three as this side holds them.
 *
 * One difference from the wire and only one: a moment is a moment here, not the string a moment
 * has to be written as to cross a network.
 */
export type HowItStopped =
  | { readonly state: 'wait'; readonly question: string }
  | { readonly state: 'sleep'; readonly until: Date }
  | { readonly state: 'done'; readonly ending: Ending; readonly text: string }

/** Reads what arrived as what this side works with. The one difference, in the one place. */
export function asStopped(how: z.infer<typeof HowItStopped>): HowItStopped {
  return how.state === 'sleep' ? { state: 'sleep', until: new Date(how.until) } : how
}

/** The moment it leaves in the conversation, for a person reading it later. */
export function said(
  how: HowItStopped,
): { readonly activityType: string } & Record<string, unknown> {
  if (how.state === 'wait') return { activityType: ACTIVITY.asked, text: how.question }
  if (how.state === 'sleep') {
    return { activityType: ACTIVITY.asleep, until: how.until.toISOString() }
  }

  return { activityType: ACTIVITY.finished, ending: how.ending, text: how.text }
}
