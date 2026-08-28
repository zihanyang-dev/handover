/**
 * A picture of every screen, so a change to how they are styled can be proven to change nothing.
 *
 * Temporary: this exists for the move from a hand-written stylesheet to tokens and utilities.
 *
 * Run it against an empty database, or it is measuring itself: names, addresses and slugs all end
 * up on screen, and a run that had to avoid the last run's would put a different string in every
 * shot — which reads as a change to the styling and is not one.
 *
 *     pnpm looks           compare against the pictures in .looks/
 *     pnpm looks:before    take them again, from where the styling is now
 */

import { expect, test, type Page } from '@playwright/test'
import { aMachine, waitsForATurn } from './a-machine.ts'
import { connects, makesASpace, signsIn } from './someone.ts'

const db = connects()

test.afterAll(async () => {
  await db.destroy()
})

async function shot(page: Page, name: string): Promise<void> {
  // The whole page, animations held still, and a moment to settle: two runs of one screen have to
  // be the same picture, or the ruler is measuring itself.
  //
  // A face is covered for the same reason. It is drawn from the id of the machine or the person it
  // belongs to, and those are new every run — the picture is different and nothing about the
  // styling is. Its box, which is styling, is still measured.
  await page.waitForTimeout(400)
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('img[src*="/avatars/"]')],
  })
}

test('every screen, as it looks today', async ({ page, context }) => {
  await page.goto('/sign-in')
  await expect(page.getByRole('form', { name: /^sign in$/iu })).toBeVisible()
  await shot(page, '01-sign-in')

  // The code screen while it is still waiting, which is only true before anybody signs in.
  await page.getByLabel(/email/iu).fill('looks@example.com')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByLabel(/digit code/iu)).toBeVisible({ timeout: 20_000 })
  await shot(page, '02-code')

  await signsIn(page, 'mina', 'mina@example.com')
  await shot(page, '03-onboarding')

  await page.goto('/connect')
  await expect(page.getByRole('heading', { name: /connect a machine/iu })).toBeVisible()
  await shot(page, '04-connect')

  await page.goto('/onboarding')
  await page.getByLabel(/workspace name/iu).fill('Acme')
  await page.getByRole('button', { name: /continue/iu }).click()
  await page.waitForURL(/\/onboarding\/host/u, { timeout: 20_000 })
  await shot(page, '05-host')

  await page.getByRole('button', { name: /skip for now/iu }).click()
  await page.waitForURL(/\/s\//u, { timeout: 20_000 })
  const slug = /\/s\/([^/]+)/u.exec(page.url())?.[1] ?? ''
  // Landing here fires a celebration once, and confetti is different every time it falls.
  await page.reload()
  await shot(page, '06-space-home')

  const machine = await aMachine(await sessionOf(context), 'mina-mbp')
  await machine.poll()
  await page.getByRole('button', { name: 'Chat' }).click()
  const agent = page.getByRole('link', { name: /on mina-mbp, ready/iu })
  await expect(agent).toBeVisible({ timeout: 15_000 })
  await shot(page, '07-space-chat-sidebar')

  await agent.click()
  await expect(page).toHaveURL(/\/a\//u)
  await shot(page, '08-start-chat')

  await page.getByLabel(/^Message /u).fill('where does the timeout live?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(/\/c\//u)
  const turn = await waitsForATurn(machine)
  await machine.says(turn, { role: 'assistant', content: { text: 'In client.ts, hard-coded.' } })
  await machine.ends(turn)
  await expect(page.getByText('In client.ts, hard-coded.')).toBeVisible({ timeout: 15_000 })
  await shot(page, '09-chat')

  await page.getByRole('button', { name: 'Inbox' }).click()
  await shot(page, '10-inbox')

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /account|settings/iu }).first()).toBeVisible()
  await shot(page, '11-settings')

  await page.goto(`/s/${slug}`)
  await page.getByRole('button', { name: /menu$/iu }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await shot(page, '12-workspace-menu')
})

async function sessionOf(context: import('@playwright/test').BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  const session = cookies.find((one) => one.name === 'handover_session')
  if (session === undefined) throw new Error('this browser is not signed in')

  return session.value
}
