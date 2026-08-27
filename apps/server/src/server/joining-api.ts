/**
 * Asking somebody into a Space, and what happens to them once they are in.
 *
 * Two doors, and the difference between them is the whole of this file. Making, listing and
 * revoking an invitation, changing what somebody may do, and taking somebody out are an owner's;
 * seeing who is here is any member's. Following a link is neither — it belongs to whoever is
 * holding the link, and what it creates is their own membership.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { inviteInto, invitationsInto, revokeInvitation, whatItOpens } from '../db/invitation.ts'
import {
  becomes,
  type Handed,
  handMachineTo,
  handWorkTo,
  joins,
  membersOf,
  removes,
  ROLE,
  whatTheyHold,
} from '../db/membership.ts'
import { SHOWS, api, endpointsBehind, saysNothing, sends, takes } from './contract.ts'
import { BEHIND_A_SESSION, body, refusal, type Failure } from './failure.ts'
import { requireMember, requireOwner, requireOwnerOrYourself, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type JoiningApi = {
  readonly db: Database
  /** Where a browser reaches this deployment, which is what makes a link a link. */
  readonly webOrigin: string
}

/** Revoked, run out, or never a link. One answer: what to do about all three is the same. */
const NO_INVITATION: Failure<404> = {
  reason: 'no-invitation',
  recovery: 'start-over',
  status: 404,
}

/** They are not in this Space, so there is nothing here to change. */
const NOT_A_MEMBER: Failure<404> = { reason: 'not-a-member', recovery: 'start-over', status: 404 }

/**
 * Whoever it was handed to is not here, or the thing is not there to hand over.
 *
 * One answer for both, because a handover is written in the statement that checks — and by the
 * time it comes back, "no rows" cannot say which. What to do about either is the same: look at
 * the screen again, which is showing what is actually true.
 */
const NOT_HANDED_OVER: Failure<404> = {
  reason: 'not-handed-over',
  recovery: 'start-over',
  status: 404,
}

/** Who something is being handed to. */
const toBody = z.object({ ownerUserId: z.uuid() }).openapi('HandTo')

/** It would leave the Space with nobody able to let anybody in. */
const THE_LAST_OWNER: Failure<409> = {
  reason: 'the-last-owner',
  recovery: 'ask-an-owner',
  status: 409,
}

const roleBody = z.enum([ROLE.owner, ROLE.member]).openapi('Role')

/** Shown once. Only its hash is kept, so this is the only moment it can be read. */
const madeBody = z
  .object({ id: z.uuid(), link: z.string(), expiresAt: z.iso.datetime() })
  .openapi('Invitation')

const openBody = z.object({ id: z.uuid(), expiresAt: z.iso.datetime() }).openapi('OpenInvitation')

const memberBody = z
  .object({
    userId: z.uuid(),
    displayName: z.string(),
    role: roleBody,
    since: z.iso.datetime(),
    /** Whether this row is the person reading it. A page cannot tell from a name. */
    you: z.boolean(),
  })
  .openapi('Member')

const heldBody = z
  .object({
    working: z
      .array(
        z.object({
          conversationId: z.uuid(),
          goal: z.string(),
          state: z.string(),
          machineName: z.string(),
        }),
      )
      .readonly(),
    machines: z
      .array(z.object({ id: z.uuid(), name: z.string(), inUse: z.number().int() }))
      .readonly(),
  })
  .openapi('StillTheirs')

const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>(SHOWS.session)
const behindASession = endpointsBehind<{ Variables: Signed }>(SHOWS.session)

/**
 * The two routes about one named person in a Space: what is still theirs, and taking them out.
 *
 * Said once because the pair has already drifted apart once. Softening the gate on one of them
 * and not the other leaves a member able to see what is theirs and unable to act on it — or, the
 * way round it happened here, able to change their own role. One decision, one place.
 */
function aboutOnePerson(deps: JoiningApi) {
  return {
    middleware: [requireSession(deps.db), requireMember(deps.db), requireOwnerOrYourself(deps.db)],
    request: { params: z.object({ slug: z.string(), userId: z.uuid() }) },
  }
}

/**
 * The two routes that hand a thing to somebody else here.
 *
 * A piece of work and a machine differ in which table moves and in nothing else a caller can see:
 * the same owner's gate, the same `{slug}` and `{id}`, the same one field in the body.
 */
function handingOver(deps: JoiningApi) {
  return {
    middleware: [requireSession(deps.db), requireMember(deps.db), requireOwner(deps.db)],
    request: {
      params: z.object({ slug: z.string(), id: z.uuid() }),
      body: takes(toBody),
    },
  }
}

export function joiningApi(deps: JoiningApi) {
  return (
    api<{ Variables: Signed & InSpace }>()
      .openapiRoutes([whoIsHere(deps), asking(deps), openOnes(deps), stopping(deps)])
      // An owner's, and the gate is mounted rather than asked for inside each handler.
      .route(
        '/',
        api<{ Variables: Signed & InSpace }>().openapiRoutes([
          moving(deps),
          taking(deps),
          stillTheirs(deps),
          handingWork(deps),
          handingAMachine(deps),
        ]),
      )
      // Following a link is nobody's but the holder's, and it names no Space in its path.
      .route('/', api<{ Variables: Signed }>().openapiRoutes([whatThisOpens(deps), joining(deps)]))
  )
}

/**
 * Makes a link, and hands over its plaintext the one time it exists.
 *
 * The whole link and not just the secret, because what somebody does next is send it to a person
 * — and a person needs an address, not a token to assemble one out of.
 */
function asking(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      path: '/spaces/{slug}/invitations',
      summary: 'Make a link somebody can join this Space with',
      middleware: [requireSession(deps.db), requireMember(deps.db), requireOwner(deps.db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        201: sends(madeBody, 'The link, shown this once and never again'),
        403: refusal('Only an owner can ask somebody in'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      const made = await inviteInto(deps.db, {
        spaceId: c.get('space').id,
        by: c.get('userId'),
      })

      return c.json(
        {
          id: made.id,
          link: `${deps.webOrigin}/join/${made.secret}`,
          expiresAt: made.expiresAt.toISOString(),
        },
        201,
      )
    },
  })
}

/** The links that still work here. Never their secrets — nobody has those any more. */
function openOnes(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/invitations',
      summary: 'The links that still work',
      middleware: [requireSession(deps.db), requireMember(deps.db), requireOwner(deps.db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(z.object({ invitations: z.array(openBody).readonly() }), 'Still working'),
        403: refusal('Only an owner can see them'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      const open = await invitationsInto(deps.db, c.get('space').id)

      return c.json(
        {
          invitations: open.map((one) => ({ id: one.id, expiresAt: one.expiresAt.toISOString() })),
        },
        200,
      )
    },
  })
}

/** Stops one working. Already-stopped answers the same, because the wanted state is the same. */
function stopping(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'delete',
      path: '/spaces/{slug}/invitations/{id}',
      summary: 'Stop a link working',
      middleware: [requireSession(deps.db), requireMember(deps.db), requireOwner(deps.db)],
      request: { params: z.object({ slug: z.string(), id: z.uuid() }) },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('It no longer works, or already did not'),
        403: refusal('Only an owner can stop one'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      await revokeInvitation(deps.db, {
        id: c.req.valid('param').id,
        spaceId: c.get('space').id,
      })

      return c.body(null, 204)
    },
  })
}

/**
 * What a link opens, for the screen that asks before anybody clicks join.
 *
 * Behind a session on purpose: without one, a link would answer "which Space is this" to whoever
 * holds it, and a stranger with a guess would learn whether a Space exists. `prd.md` 01 ⑥.
 */
function whatThisOpens(deps: JoiningApi) {
  return behindASession({
    route: createRoute({
      method: 'get',
      path: '/invitations/{secret}',
      summary: 'Which Space this link is for, and who asked you',
      middleware: [requireSession(deps.db)],
      request: { params: z.object({ secret: z.string().min(1).max(200) }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(
          z.object({ slug: z.string(), displayName: z.string(), invitedBy: z.string() }),
          'The Space, and who asked',
        ),
        404: refusal('That link does not work'),
      },
    }),

    handler: async (c) => {
      const opens = await whatItOpens(deps.db, c.req.valid('param').secret)
      if (opens.kind === 'no-invitation') return c.json(body(NO_INVITATION), NO_INVITATION.status)

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
function joining(deps: JoiningApi) {
  return behindASession({
    route: createRoute({
      method: 'post',
      path: '/me/spaces',
      summary: 'Join a Space with a link',
      middleware: [requireSession(deps.db)],
      request: {
        body: takes(z.object({ secret: z.string().min(1).max(200) }).openapi('JoinWith')),
      },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(z.object({ slug: z.string() }), 'You are in, or already were'),
        404: refusal('That link does not work'),
      },
    }),

    handler: async (c) => {
      const opens = await whatItOpens(deps.db, c.req.valid('json').secret)
      if (opens.kind === 'no-invitation') return c.json(body(NO_INVITATION), NO_INVITATION.status)

      const joined = await joins(deps.db, {
        userId: c.get('userId'),
        spaceId: opens.spaceId,
        slug: opens.slug,
      })

      // Already in answers the same as just in: what was asked for is true either way, and a
      // second click on a link somebody kept is not a mistake worth a different screen.
      return c.json({ slug: joined.slug }, 200)
    },
  })
}

/** Who is here. Any member's, because a Space is the people in it. */
function whoIsHere(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/members',
      summary: 'Who is in this Space',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(z.object({ members: z.array(memberBody).readonly() }), 'Everybody here'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      const here = await membersOf(deps.db, c.get('space').id, c.get('userId'))

      return c.json(
        { members: here.map((one) => ({ ...one, since: one.since.toISOString() })) },
        200,
      )
    },
  })
}

/** Changes what somebody may do here. Refused when it would leave nobody who can do anything. */
function moving(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'patch',
      path: '/spaces/{slug}/members/{userId}',
      summary: 'Change what somebody may do here',
      middleware: [requireSession(deps.db), requireMember(deps.db), requireOwner(deps.db)],
      request: {
        params: z.object({ slug: z.string(), userId: z.uuid() }),
        body: takes(z.object({ role: roleBody }).openapi('NewRole')),
      },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('Changed'),
        403: refusal('Only an owner can change this'),
        404: refusal('No such Space, or nobody here by that name'),
        409: refusal('It would leave the Space with no owner'),
      },
    }),

    handler: async (c) => {
      const moved = await becomes(
        deps.db,
        { spaceId: c.get('space').id, userId: c.req.valid('param').userId },
        c.req.valid('json').role,
      )
      if (moved.kind === 'not-a-member') return c.json(body(NOT_A_MEMBER), NOT_A_MEMBER.status)
      if (moved.kind === 'the-last-owner')
        return c.json(body(THE_LAST_OWNER), THE_LAST_OWNER.status)

      return c.body(null, 204)
    },
  })
}

/**
 * Takes somebody out. Leaving is the same route, aimed at yourself.
 *
 * Nothing they hold moves or stops — whoever pressed this has already been shown what that is,
 * one line at a time, and decided about each. See {@link stillTheirs}.
 */
function taking(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'delete',
      path: '/spaces/{slug}/members/{userId}',
      summary: 'Take somebody out of this Space, or leave it yourself',
      ...aboutOnePerson(deps),
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('Out, and their credentials stop reaching this Space'),
        403: refusal('Only an owner can take somebody else out'),
        404: refusal('No such Space, or nobody here by that name'),
        409: refusal('It would leave the Space with no owner'),
      },
    }),

    handler: async (c) => {
      const out = await removes(deps.db, {
        spaceId: c.get('space').id,
        userId: c.req.valid('param').userId,
      })
      if (out.kind === 'not-a-member') return c.json(body(NOT_A_MEMBER), NOT_A_MEMBER.status)
      if (out.kind === 'the-last-owner') return c.json(body(THE_LAST_OWNER), THE_LAST_OWNER.status)

      return c.body(null, 204)
    },
  })
}

/**
 * What is still theirs, read before anybody presses remove.
 *
 * The point of the whole slice: taking somebody out is a list to work through, not a button.
 * Nothing here is stopped or moved by asking.
 */
function stillTheirs(deps: JoiningApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/members/{userId}/held',
      summary: 'What is still theirs here, before anybody is taken out',
      ...aboutOnePerson(deps),
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(heldBody, 'Their open work, and their machines'),
        403: refusal('Only an owner can see what is somebody else’s'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      const held = await whatTheyHold(deps.db, {
        spaceId: c.get('space').id,
        userId: c.req.valid('param').userId,
      })

      return c.json(held, 200)
    },
  })
}

/**
 * Handing one thing here to one person here.
 *
 * Written once and called twice, because a piece of work and a machine differ in exactly one
 * thing a caller can see — which table moves — and in nothing else. Two copies of this would be
 * two places to remember that handing something to somebody who is not here is a 404 and not a
 * 403, and the second copy is the one that would eventually say something else.
 *
 * `PATCH` and not a `POST` to some transfer: nothing is created. One field of a thing that
 * already exists says somebody else's name now.
 */
function handingOverOne(
  deps: JoiningApi,
  what: {
    readonly path: '/spaces/{slug}/conversations/{id}/task' | '/spaces/{slug}/machines/{id}'
    readonly summary: string
    readonly moved: string
    readonly missing: string
    readonly move: (
      db: Database,
      to: { readonly spaceId: string; readonly id: string; readonly userId: string },
    ) => Promise<Handed>
  },
) {
  return behindAMembership({
    route: createRoute({
      method: 'patch',
      path: what.path,
      summary: what.summary,
      ...handingOver(deps),
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing(what.moved),
        403: refusal('Only an owner can hand something over'),
        404: refusal(what.missing),
      },
    }),

    handler: async (c) => {
      const handed = await what.move(deps.db, {
        spaceId: c.get('space').id,
        id: c.req.valid('param').id,
        userId: c.req.valid('json').ownerUserId,
      })
      if (handed.kind === 'not-a-member')
        return c.json(body(NOT_HANDED_OVER), NOT_HANDED_OVER.status)

      return c.body(null, 204)
    },
  })
}

/** Whose piece of work it is — which is also who the Inbox tells, because it is one column. */
function handingWork(deps: JoiningApi) {
  return handingOverOne(deps, {
    path: '/spaces/{slug}/conversations/{id}/task',
    summary: 'Hand a piece of work to somebody else here',
    moved: 'It is theirs, and it is in their Inbox',
    missing: 'No such Space, nothing running there, or nobody here by that name',
    // Named at the boundary: in a path it is `{id}`, and by the time it reaches the tables it
    // is a conversation. Three opaque ids in one call is where they get swapped.
    move: async (db, to) =>
      handWorkTo(db, { spaceId: to.spaceId, conversationId: to.id, userId: to.userId }),
  })
}

/**
 * Whose machine it is.
 *
 * Whoever approved it still approved it — that is history and does not move. What moves is which
 * Spaces it can be reached from and who may disconnect it.
 */
function handingAMachine(deps: JoiningApi) {
  return handingOverOne(deps, {
    path: '/spaces/{slug}/machines/{id}',
    summary: 'Hand a machine to somebody else here',
    moved: 'It is theirs',
    missing: 'No such Space, no such machine, or nobody here by that name',
    move: async (db, to) =>
      handMachineTo(db, { spaceId: to.spaceId, machineId: to.id, userId: to.userId }),
  })
}
