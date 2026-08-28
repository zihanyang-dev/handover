/**
 * A second person arriving by a link, walked in two browsers.
 *
 * Two real contexts rather than one page with two sessions: what is under test is that the second
 * person sees a Space they were never given anything for except a link, and a single browser
 * carrying both cookies could pass that without it being true.
 *
 * The link is made through the database rather than pressed for, because the screen that made
 * one is not in the rebuilt app. Everything after that is the shipped thing — the link screen,
 * joining, and being inside. What the rest of `prd.md` 05 promises — inviting, stopping a link,
 * changing a role, taking somebody out and their machine with them — has a working server side
 * with nowhere to press it, so it is proven in `apps/server/src/db/joining.spec.ts` and
 * `apps/server/src/server/joining-a-space.spec.ts` instead, and named in
 * `rules/reachable.spec.ts`.
 */

import { expect, test } from '@playwright/test'
import { inviteInto } from '../apps/server/src/db/invitation.ts'
import { connects, makesASpace, signsIn } from './someone.ts'

const db = connects()

test.afterAll(async () => {
  await db.destroy()
})

test('somebody who was sent a link ends up inside the same Space', async ({ browser }) => {
  const kaiBrowser = await browser.newContext()
  const kai = await kaiBrowser.newPage()
  await signsIn(kai, 'kai')
  const slug = await makesASpace(kai)

  const space = await db
    .selectFrom('spaces')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirstOrThrow()
  const owner = await db
    .selectFrom('memberships')
    .select('user_id as userId')
    .where('space_id', '=', space.id)
    .executeTakeFirstOrThrow()
  const invitation = await inviteInto(db, { spaceId: space.id, by: owner.userId })

  // A second person, in their own browser, follows it. Signed in first: a link that answered to
  // nobody would tell whoever guessed an address whether a Space exists. `prd.md` 01 ⑥.
  const minaBrowser = await browser.newContext()
  const mina = await minaBrowser.newPage()
  await signsIn(mina, 'mina')
  await mina.goto(`/join/${invitation.secret}`)

  await expect(mina.getByRole('heading', { name: /asked you to join/u })).toBeVisible({
    timeout: 15_000,
  })
  await mina.getByRole('button', { name: /^Join / }).click()
  await mina.waitForURL(new RegExp(`/s/${slug}`, 'u'), { timeout: 20_000 })
})
