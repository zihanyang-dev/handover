/**
 * A second person arriving by a link, and the owner managing that relationship through the shipped UI.
 *
 * Two real contexts rather than one page with two sessions: the second person has nothing except
 * the one-time link, and removal must revoke the second browser rather than merely update a row in
 * the first browser.
 */

import { expect, test } from '@playwright/test'
import { aMachine, waitsForATurn } from './a-machine.ts'
import { makesASpace, signsIn } from './someone.ts'

test('an owner invites, promotes, removes, and revokes through Space Settings', async ({
  browser,
}) => {
  const kaiBrowser = await browser.newContext()
  const kai = await kaiBrowser.newPage()
  const kaiAddress = await signsIn(kai, 'kai')
  const slug = await makesASpace(kai)

  const firstLink = await makeInviteLink(kai)
  const minaBrowser = await browser.newContext()
  const mina = await minaBrowser.newPage()
  const minaAddress = await signsIn(mina, 'mina')
  await mina.goto(firstLink)

  await expect(mina.getByRole('heading', { name: /asked you to join/u })).toBeVisible({
    timeout: 15_000,
  })
  await mina.getByRole('button', { name: /^Join /u }).click()
  await mina.waitForURL((url) => url.pathname === `/s/${slug}`, { timeout: 20_000 })

  const machine = await aMachine(await sessionOf(minaBrowser), 'mina-mbp', slug)
  await machine.poll()
  await picks(mina, 'mina-mbp')
  await mina.getByLabel(/^Message /u).fill('keep the release moving')
  await mina.getByRole('button', { name: 'Send' }).click()
  const turn = await waitsForATurn(machine)
  const goal = 'Keep the release moving and report any blocker'
  await machine.says(turn, {
    role: 'activity',
    content: { activityType: 'proposed', text: goal },
  })
  await machine.ends(turn)
  await mina
    .getByRole('article', { name: 'Proposed handover' })
    .getByRole('button', { name: 'Hand over' })
    .click()
  await expect(mina.getByRole('heading', { name: 'Piece of work' })).toBeVisible({
    timeout: 15_000,
  })

  await openSettings(kai)
  const roleLabel = `${minaAddress} role`
  const role = kai.getByRole('button', { name: roleLabel })
  await expect(role).toBeVisible({ timeout: 15_000 })
  await role.click()
  await kai
    .getByRole('menu', { name: roleLabel })
    .getByRole('menuitemradio', { name: 'Owner' })
    .click()
  await expect(role).toContainText('Owner')
  await role.click()
  await kai
    .getByRole('menu', { name: roleLabel })
    .getByRole('menuitemradio', { name: 'Member' })
    .click()
  await expect(role).toContainText('Member')

  const secondLink = await createInviteLinkInsideSettings(kai)
  await kai.getByRole('button', { name: 'Disable invite link' }).click()
  await role.click()
  await kai
    .getByRole('menu', { name: roleLabel })
    .getByRole('menuitem', { name: 'Remove from Space' })
    .click()
  await expect(kai.getByRole('heading', { name: `Remove ${minaAddress}` })).toBeVisible()
  await expect(kai.getByText(goal)).toBeVisible()
  await expect(kai.getByText('mina-mbp', { exact: true })).toBeVisible()
  await expect(kai.getByRole('button', { name: 'New owner' }).first()).toContainText(kaiAddress)

  await kai.getByRole('button', { name: 'Transfer' }).first().click()
  await expect(kai.getByText(goal)).not.toBeVisible({ timeout: 15_000 })
  await expect(kai.getByRole('heading', { name: 'Machines' })).toBeVisible({ timeout: 15_000 })
  await expect(kai.getByText(/It will be removed from this Space/u)).toBeVisible()
  const removeMember = kai.getByRole('button', { name: 'Remove member' })
  await expect(removeMember).toBeEnabled()
  await removeMember.click()

  await mina.reload()
  await expect(mina.getByText(/this space is not available/i)).toBeVisible({ timeout: 15_000 })

  const ruiBrowser = await browser.newContext()
  const rui = await ruiBrowser.newPage()
  await signsIn(rui, 'rui')
  await rui.goto(secondLink)
  await expect(rui.getByRole('heading', { name: 'This link no longer works' })).toBeVisible({
    timeout: 15_000,
  })

  await Promise.all([kaiBrowser.close(), minaBrowser.close(), ruiBrowser.close()])
})

async function picks(page: import('@playwright/test').Page, machineName: string): Promise<void> {
  await page.getByRole('tab', { name: 'Chat' }).click()
  const agent = page.getByRole('link', {
    name: `Claude Code on ${machineName}, ready`,
    exact: true,
  })
  await expect(agent).toBeVisible({ timeout: 15_000 })
  await agent.click()
}

async function sessionOf(context: import('@playwright/test').BrowserContext): Promise<string> {
  const session = (await context.cookies()).find((cookie) => cookie.name === 'handover_session')
  if (session === undefined) throw new Error('this browser is not signed in')
  return session.value
}

async function makeInviteLink(page: import('@playwright/test').Page): Promise<string> {
  await openSettings(page)
  const link = await createInviteLinkInsideSettings(page)
  await page.getByRole('button', { name: 'Close settings' }).click()
  return link
}

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Open .* menu/u }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
}

async function createInviteLinkInsideSettings(
  page: import('@playwright/test').Page,
): Promise<string> {
  await page.getByRole('button', { name: /^(?:Create invite link|Replace link)$/u }).click()
  const revealed = page
    .getByRole('group', { name: 'Active invite link' })
    .locator('span[title^="http"]')
  await expect(revealed).toBeVisible()
  const link = await revealed.getAttribute('title')
  if (link === null) throw new Error('the new invitation link was not revealed')
  return link
}
