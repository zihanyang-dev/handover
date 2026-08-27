/**
 * The links that let somebody into a Space: making one, seeing the ones that still work, stopping
 * one, and following one.
 *
 * Three doors, and that is the whole shape of this file. Making, listing and revoking are an
 * owner's. Following a link is neither an owner's nor a member's — it belongs to whoever is
 * holding it, and what it creates is their own membership.
 */

import { z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import {
  inviteInto,
  invitationsInto,
  joinWith,
  revokeInvitation,
  whatItOpens,
} from '../db/invitation.ts'
import { type Failure, refused } from './failure.ts'
import { aPerson, anOwner, list, named, nothing, refuses, rowId, sends } from './route.ts'

export type InvitationApi = {
  readonly db: Database
  /** Where a browser reaches this deployment, which is what makes a link a link. */
  readonly webOrigin: string
}

/** Shown once. Only its hash is kept, so this is the only moment it can be read. */
const Made = named('Invitation', { id: rowId, link: z.string(), expiresAt: z.iso.datetime() })

const Open = named('OpenInvitation', { id: rowId, expiresAt: z.iso.datetime() })

/** As long as a link's secret may be. Longer is not a link anybody was given. */
const secret = z.string().min(1).max(200)

const Invitations = list('invitations', Open)

/** Which Space a link is for, and who is asking. */
const Opens = named('Opens', {
  slug: z.string(),
  displayName: z.string(),
  invitedBy: z.string(),
})

const JoinWith = named('JoinWith', { secret })

const Joined = named('Joined', { slug: z.string() })

/** Revoked, run out, or never a link. One answer: what to do about all three is the same. */
const NO_INVITATION: Failure<404> = { reason: 'no-invitation', recovery: 'start-over', status: 404 }

export function invitationApi(deps: InvitationApi) {
  return [asking(deps), openOnes(deps), stopping(deps), whatThisOpens(deps), joining(deps)]
}

/**
 * Makes a link, and hands over its plaintext the one time it exists.
 *
 * The whole link and not just the secret, because what somebody does next is send it to a person
 * — and a person needs an address, not a token to assemble one out of.
 */
function asking({ db, webOrigin }: InvitationApi) {
  return anOwner(db).post('/spaces/{slug}/invitations', {
    summary: 'Make a link somebody can join this Space with',
    answers: { 201: sends(Made, 'The link, shown this once and never again') },

    run: async (c) => {
      const made = await inviteInto(db, { spaceId: c.get('space').id, by: c.get('userId') })

      return c.json(
        {
          id: made.id,
          link: `${webOrigin}/join/${made.secret}`,
          expiresAt: made.expiresAt.toISOString(),
        },
        201,
      )
    },
  })
}

/** The links that still work here. Never their secrets — nobody has those any more. */
function openOnes({ db }: InvitationApi) {
  return anOwner(db).get('/spaces/{slug}/invitations', {
    summary: 'The links that still work',
    answers: { 200: sends(Invitations, 'Still working') },

    run: async (c) => {
      const open = await invitationsInto(db, c.get('space').id)

      return c.json(
        {
          invitations: open.map((one) => ({ id: one.id, expiresAt: one.expiresAt.toISOString() })),
        },
        200,
      )
    },
  })
}

/** Stops one working. Already stopped answers the same, because the wanted state is the same. */
function stopping({ db }: InvitationApi) {
  return anOwner(db).delete('/spaces/{slug}/invitations/{id}', {
    summary: 'Stop a link working',
    params: { id: rowId },
    answers: { 204: 'It no longer works, or already did not' },

    run: async (c) => {
      await revokeInvitation(db, { id: c.req.valid('param').id, spaceId: c.get('space').id })

      return nothing(c, 204)
    },
  })
}

/** What a link opens, for the screen that asks before anybody clicks join. */
function whatThisOpens({ db }: InvitationApi) {
  return aPerson(db).get('/invitations/{secret}', {
    summary: 'Which Space this link is for, and who asked you',
    params: { secret },
    answers: {
      200: sends(Opens, 'The Space, and who asked'),
      404: refuses(NO_INVITATION, 'That link does not work'),
    },

    run: async (c) => {
      const opens = await whatItOpens(db, c.req.valid('param').secret)
      if (opens.kind === 'no-invitation') return refused(c, NO_INVITATION)

      return c.json(
        { slug: opens.slug, displayName: opens.displayName, invitedBy: opens.invitedBy },
        200,
      )
    },
  })
}

/**
 * Joining, which creates one thing: this person's membership.
 *
 * `POST /me/spaces` and not `POST /spaces/{slug}/members`, because what happens is "my list of
 * Spaces got longer", and the secret is a credential rather than part of an address — the same
 * shape as claiming a machine.
 */
function joining({ db }: InvitationApi) {
  return aPerson(db).post('/me/spaces', {
    summary: 'Join a Space with a link',
    body: JoinWith,
    answers: {
      200: sends(Joined, 'You are in, or already were'),
      404: refuses(NO_INVITATION, 'That link does not work'),
    },

    run: async (c) => {
      // One transaction, which is what makes the answer true at the moment it is acted on: read
      // and written separately, a link stopped in between still lets somebody in.
      const joined = await joinWith(db, {
        secret: c.req.valid('json').secret,
        userId: c.get('userId'),
      })
      if (joined.kind === 'no-invitation') return refused(c, NO_INVITATION)

      // Already in answers the same as just in: what was asked for is true either way, and a
      // second click on a link somebody kept is not a mistake worth a different screen.
      return c.json({ slug: joined.slug }, 200)
    },
  })
}
