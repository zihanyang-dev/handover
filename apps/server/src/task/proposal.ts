/**
 * The card an agent writes when it proposes taking a piece of work on.
 *
 * A shape rather than a row: what is stored is a transcript line like any other, and this is how
 * that line is read back when somebody confirms the exact one they were looking at.
 */

import { z } from '@hono/zod-openapi'
import { ACTIVITY } from '../conversation/transcript.ts'

export const Proposal = z.object({
  activityType: z.literal(ACTIVITY.proposed),
  text: z.string().min(1).max(2000),
})
