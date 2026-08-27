/**
 * Who is in a Space, and what happens to one of them.
 *
 * Seeing who is here is any member's — a Space is the people in it. Changing what somebody may do
 * is an owner's. Taking somebody out is an owner's too, except when it is yourself, which is what
 * leaving is: the same route, aimed at your own name.
 */

import { z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { ROLE, becomes, membersOf, removes, whatTheyHold } from '../db/membership.ts'
import { type Failure, refused } from './failure.ts'
import {
  aMember,
  anOwner,
  anOwnerOrYourself,
  list,
  named,
  nothing,
  refuses,
  rowId,
  sends,
} from './route.ts'

export type MemberApi = { readonly db: Database }

/** They are not in this Space, so there is nothing here to change. */
const NOT_A_MEMBER: Failure<404> = { reason: 'not-a-member', recovery: 'start-over', status: 404 }

/** It would leave the Space with nobody able to let anybody in. */
const THE_LAST_OWNER: Failure<409> = {
  reason: 'the-last-owner',
  recovery: 'ask-an-owner',
  status: 409,
}

const Role = z.enum([ROLE.owner, ROLE.member]).openapi('Role')

const Member = named('Member', {
  userId: rowId,
  displayName: z.string(),
  role: Role,
  since: z.iso.datetime(),
  /** Whether this row is the person reading it. A page cannot tell from a name. */
  you: z.boolean(),
})

const WorkTheyHold = named('WorkTheyHold', {
  conversationId: rowId,
  goal: z.string(),
  state: z.string(),
  machineName: z.string(),
})

const MachineTheyHold = named('MachineTheyHold', {
  id: rowId,
  name: z.string(),
  inUse: z.number().int(),
})

const StillTheirs = named('StillTheirs', {
  working: z.array(WorkTheyHold).readonly(),
  machines: z.array(MachineTheyHold).readonly(),
})

const Members = list('members', Member)

const NewRole = named('NewRole', { role: Role })

export function memberApi(deps: MemberApi) {
  return [whoIsHere(deps), moving(deps), stillTheirs(deps), taking(deps)]
}

/** A Space is the people in it, so any member may see them. */
function whoIsHere({ db }: MemberApi) {
  return aMember(db).get('/spaces/{slug}/members', {
    summary: 'Who is in this Space',
    answers: { 200: sends(Members, 'Everybody here') },

    run: async (c) => {
      const here = await membersOf(db, c.get('space').id, c.get('userId'))

      return c.json(
        { members: here.map((one) => ({ ...one, since: one.since.toISOString() })) },
        200,
      )
    },
  })
}

/** Refused when it would leave the Space with nobody who can do anything. */
function moving({ db }: MemberApi) {
  return anOwner(db).patch('/spaces/{slug}/members/{userId}', {
    summary: 'Change what somebody may do here',
    params: { userId: rowId },
    body: NewRole,
    answers: {
      204: 'Changed',
      404: refuses(NOT_A_MEMBER, 'No such Space, or nobody here by that name'),
      409: refuses(THE_LAST_OWNER, 'It would leave the Space with no owner'),
    },

    run: async (c) => {
      const moved = await becomes(
        db,
        { spaceId: c.get('space').id, userId: c.req.valid('param').userId },
        c.req.valid('json').role,
      )
      if (moved.kind === 'not-a-member') return refused(c, NOT_A_MEMBER)
      if (moved.kind === 'the-last-owner') return refused(c, THE_LAST_OWNER)

      return nothing(c, 204)
    },
  })
}

/**
 * What is still theirs, read before anybody presses remove.
 *
 * The point of the whole slice: taking somebody out is a list to work through, not a button.
 * Nothing here is stopped or moved by asking.
 */
function stillTheirs({ db }: MemberApi) {
  return anOwnerOrYourself(db).get('/spaces/{slug}/members/{userId}/held', {
    summary: 'What is still theirs here, before anybody is taken out',
    params: { userId: rowId },
    answers: { 200: sends(StillTheirs, 'Their open work, and their machines') },

    run: async (c) => {
      const held = await whatTheyHold(db, {
        spaceId: c.get('space').id,
        userId: c.req.valid('param').userId,
      })

      return c.json(held, 200)
    },
  })
}

/**
 * Takes somebody out. Leaving is this same route, aimed at yourself.
 *
 * Nothing they hold moves or stops — whoever pressed this has already been shown what that is,
 * one line at a time, and decided about each. See {@link stillTheirs}.
 */
function taking({ db }: MemberApi) {
  return anOwnerOrYourself(db).delete('/spaces/{slug}/members/{userId}', {
    summary: 'Take somebody out of this Space, or leave it yourself',
    params: { userId: rowId },
    answers: {
      204: 'Out, and their credentials stop reaching this Space',
      404: refuses(NOT_A_MEMBER, 'No such Space, or nobody here by that name'),
      409: refuses(THE_LAST_OWNER, 'It would leave the Space with no owner'),
    },

    run: async (c) => {
      const out = await removes(db, {
        spaceId: c.get('space').id,
        userId: c.req.valid('param').userId,
      })
      if (out.kind === 'not-a-member') return refused(c, NOT_A_MEMBER)
      if (out.kind === 'the-last-owner') return refused(c, THE_LAST_OWNER)

      return nothing(c, 204)
    },
  })
}
