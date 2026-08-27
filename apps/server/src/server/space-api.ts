/**
 * Spaces: making one, and entering one.
 *
 * Both are behind a live session, so "who is asking" is never a parameter and never something a
 * caller can claim. Making one is behind the weaker of the two doors: there is no Space to be a
 * member of yet, which is the whole of what it is for.
 */

import { normalizeSlug } from '@handover/universal'
import { z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { changeSpaceEmoji, createSpace } from '../db/space.ts'
import { type Failure, refused } from './failure.ts'
import { NOT_YOURS } from './middleware.ts'
import { aMember, aPerson, anOwner, named, nothing, refuses, sends } from './route.ts'

export type SpaceApi = { readonly db: Database }

/** A name of pure punctuation has no address, and no address means no Space. */
const UNUSABLE_NAME: Failure<400> = {
  reason: 'unusable-name',
  recovery: 'choose-another-name',
  status: 400,
}

/** A Space as anything that shows one says it. Said here, and read by `me-api.ts` too. */
export const Space = named('Space', {
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  emoji: z.string(),
})

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

const PICTURE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u

/**
 * One visible mark, rather than a string that happens to begin with one.
 *
 * A flag is two code points and a family with skin tones is well over ten, so what is counted is
 * graphemes and not length. The 32 is only there so nothing unbounded reaches the segmenter.
 */
const NewEmoji = named('NewSpaceEmoji', {
  emoji: z
    .string()
    .min(1)
    .max(32)
    .refine(
      (value) => [...GRAPHEMES.segment(value)].length === 1 && PICTURE.test(value),
      'Choose one emoji',
    ),
})

const NewSpace = named('NewSpace', {
  displayName: z.string().min(1).max(200).openapi({ example: '徐悦泰 Studio' }),
  requestKey: z.string().min(1).max(200),
})

const SlugTaken = named('SlugTaken', {
  reason: z.literal('slug-taken'),
  recovery: z.literal('choose-another-name'),
  suggestion: z.string().openapi({ example: 'acme-2' }),
})

export function spaceApi(deps: SpaceApi) {
  return [making(deps), entering(deps), changingEmoji(deps)]
}

/** Making one, with whoever asked as its first member. */
function making({ db }: SpaceApi) {
  return aPerson(db).post('/spaces', {
    summary: 'Make a Space',
    body: NewSpace,
    answers: {
      201: sends(Space, 'Made, with the requester as its first member'),
      200: sends(Space, 'This request key already made one, and this is that one'),
      400: refuses(UNUSABLE_NAME, 'The name has no address in it'),
      409: sends(SlugTaken, 'Somebody holds that address; the suggestion is held for nobody'),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const slug = normalizeSlug(asked.displayName)
      if (slug === null) return refused(c, UNUSABLE_NAME)

      const made = await createSpace(db, {
        requestKey: asked.requestKey,
        userId: c.get('userId'),
        displayName: asked.displayName.trim(),
        slug,
      })

      if (made.kind === 'slug-taken') {
        const taken = { reason: 'slug-taken', recovery: 'choose-another-name' } as const
        return c.json({ ...taken, suggestion: made.suggestion }, 409)
      }

      return c.json(made.space, made.kind === 'created' ? 201 : 200)
    },
  })
}

/**
 * Changing the mark people recognise this Space by.
 *
 * An owner's job, for the same reason the name is: it appears to everybody, and it is the
 * identity under which invitations and conversations are read. The door has already said so; the
 * write says it again because the door's answer can go stale while the transaction waits.
 */
function changingEmoji({ db }: SpaceApi) {
  return anOwner(db).patch('/spaces/{slug}', {
    summary: 'Change the emoji that identifies this Space',
    body: NewEmoji,
    answers: { 204: 'Changed' },

    run: async (c) => {
      const changed = await changeSpaceEmoji(db, {
        spaceId: c.get('space').id,
        userId: c.get('userId'),
        emoji: c.req.valid('json').emoji,
      })

      return changed ? nothing(c, 204) : refused(c, NOT_YOURS)
    },
  })
}

/** Entering one. The door answers it entirely: reaching the handler is the whole question. */
function entering({ db }: SpaceApi) {
  return aMember(db).get('/spaces/{slug}', {
    summary: 'Enter a Space',
    answers: { 200: sends(Space, 'The Space at this address') },

    run: (c) => c.json(c.get('space'), 200),
  })
}
