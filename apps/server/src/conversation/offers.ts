/**
 * What an agent lets a person choose, on the wire.
 *
 * Two screens read it — the machines list and one conversation — and a machine writes it, so the
 * shape is stated once here rather than in each of the three. Written twice it would eventually
 * be tightened in one place and not the other, and nothing would say which was the real one.
 *
 * Closed, unlike a tool's name or a kind of activity. Those are other people's words and this is
 * ours: every adapter turns what its own SDK says into exactly this, so a page has one shape to
 * render whichever agent it is looking at.
 */

import { z } from '@hono/zod-openapi'

const Model = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(200),
    about: z.string().max(2000),
    /** How hard this particular model may be asked to think. Empty when it has no such setting. */
    efforts: z.array(z.string().max(50)).max(20).readonly(),
    /** What it uses when nobody says. Absent when the agent does not name one. */
    defaultEffort: z.string().max(50).optional(),
    /** The one a person gets by saying nothing. */
    isDefault: z.boolean(),
  })
  .openapi('Model')

/**
 * Empty covers two situations a page treats the same: an agent that offers no choice, and one
 * nobody has asked yet. Both mean no control, and neither means anything is wrong.
 */
export const Models = z.array(Model).max(100).readonly()
