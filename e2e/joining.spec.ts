/**
 * The journey `prd.md` 05 describes, walked by two people in two browsers.
 *
 * Two real contexts rather than one page with two sessions: what is under test is that the second
 * person sees a Space they were never given anything for except a link, and a single browser
 * carrying both cookies could pass that without it being true.
 *
 * This is the first test in the suite where anything belongs to somebody. Until this slice a Space
 * had exactly one person in it, so every rule written for a second one — whose machine this is,
 * who may disconnect it, who may let anybody in — had never been walked.
 */

import { expect, test, type BrowserContext } from '@playwright/test'
import { aMachine } from './a-machine.ts'
import { db, makesASpace, signsIn } from './someone.ts'

test.afterAll(async () => {
  await db.destroy()
})

test('ask somebody in, and take them out again', async ({ browser }) => {
  const kaiBrowser = await browser.newContext()
  const kai = await kaiBrowser.newPage()

  // ① The first person makes a Space and connects a machine of their own.
  const kaiAddress = await signsIn(kai, 'kai')
  const slug = await makesASpace(kai)
  const laptop = await aMachine(await sessionOf(kaiBrowser), 'kai-mbp')
  await laptop.poll()
  await expect(kai.getByText('kai-mbp')).toBeVisible({ timeout: 15_000 })

  // ② A link, made from inside the Space. The plaintext is on the screen exactly once, which is
  // why it is read off the page here rather than out of the database.
  await kai.getByRole('tab', { name: 'People' }).click()
  await kai.getByRole('button', { name: 'Make a link' }).click()
  const link = await kai.getByRole('code').innerText()
  expect(link).toContain('/join/')

  // ③ A second person, in their own browser, follows it.
  const minaBrowser = await browser.newContext()
  const mina = await minaBrowser.newPage()
  const minaAddress = await signsIn(mina, 'mina')
  await mina.goto(new URL(link).pathname)

  await expect(mina.getByRole('heading', { name: /asked you to join/u })).toBeVisible({
    timeout: 15_000,
  })
  await mina.getByRole('button', { name: /^Join / }).click()
  await mina.waitForURL(new RegExp(`/s/${slug}`, 'u'), { timeout: 20_000 })

  // ④ Inside, she sees the same Space — including a machine that is not hers, said to be his.
  await expect(mina.getByText('kai-mbp')).toBeVisible({ timeout: 15_000 })
  await expect(mina.getByText(/’s$/u)).toBeVisible()

  // ⑤ And she cannot take it away. `prd.md` 05 ③: you can use it, you cannot have it.
  await expect(mina.getByRole('button', { name: 'Disconnect' })).toHaveCount(0)

  // ⑥ She connects a machine of her own, which he can see and cannot take away.
  const hers = await aMachine(await sessionOf(minaBrowser), 'mina-mbp')
  await hers.poll()

  // ⑦ He sees her, and that she is not an owner.
  await kai.reload()
  await kai.getByRole('tab', { name: 'People' }).click()
  await expect(kai.getByText(minaAddress)).toBeVisible({ timeout: 15_000 })
  // Exact, because `getByText` matches a substring without a case: `Make an owner` is on
  // every row that is not already one.
  await expect(kai.getByText('Owner', { exact: true })).toHaveCount(1)

  // ⑧ Taking her out is a list first, and her machine is on it. Nothing on it moves by itself,
  // and the screen says so.
  await kai.getByRole('button', { name: 'Remove' }).click()
  await expect(kai.getByText('mina-mbp')).toBeVisible({ timeout: 15_000 })
  await expect(kai.getByText(/Nothing here stops or moves/u)).toBeVisible()

  // ⑨ So he takes the machine first — Tailscale's lesson, which is that deleting the person
  // deletes their devices and the connections stop. Handed over, it stays.
  await kai.getByLabel('Hand it to').selectOption({ label: kaiAddress })
  await expect(kai.getByText('mina-mbp')).toHaveCount(0, { timeout: 15_000 })

  await kai.getByRole('button', { name: `Remove ${minaAddress}` }).click()
  await expect(kai.getByText(minaAddress)).toHaveCount(0, { timeout: 15_000 })

  // ⑩ The machine is still here, and now it is his.
  await kai.getByRole('tab', { name: 'Home' }).click()
  await expect(kai.getByText('mina-mbp')).toBeVisible({ timeout: 15_000 })
  await expect(kai.getByText(/’s$/u)).toHaveCount(0)

  // ⑪ Her session is still hers — she is signed in — and this Space is simply not there any more.
  await mina.reload()
  await expect(mina.getByRole('heading', { name: /not available/u })).toBeVisible({
    timeout: 15_000,
  })
})

test('the only owner is stopped from leaving, and told what to do first', async ({ page }) => {
  // The rule with a real trap behind it: a Space whose last owner walked out is a Space nobody
  // can ever let anybody into. `prd.md` 05 ⑤.
  await signsIn(page, 'rui')
  await makesASpace(page)

  await page.getByRole('tab', { name: 'People' }).click()
  await page.getByRole('button', { name: 'Leave' }).click()
  await page.getByRole('button', { name: 'Leave this Space' }).click()

  await expect(page.getByText(/only owner here/u)).toBeVisible({ timeout: 15_000 })
})

/** The session this browser is carrying, which a machine needs to ask for a key. */
async function sessionOf(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  const session = cookies.find((one) => one.name === 'handover_session')
  if (session === undefined) throw new Error('this browser is not signed in')

  return session.value
}
