/**
 * The journey `prd.md` 04 describes, walked in a browser.
 *
 * Everything here is the shipped thing: the built app, one origin, the real routes, a real
 * Postgres. The one stand-in is the agent process — see `a-machine.ts` for why, and where the
 * real agents are tested instead.
 *
 * What this is for is the half no unit test reaches: that the screens, the API and the machine
 * protocol agree about the same conversation at the same time.
 */

import { expect, test } from '@playwright/test'
import { aMachine, waitsForATurn } from './a-machine.ts'
import { db, makesASpace, signsIn } from './someone.ts'

test.afterAll(async () => {
  await db.destroy()
})

test('talk to an agent, hand it over, and be asked something', async ({ page, context }) => {
  // ① Sign in from the front door and make a Space — which lands straight in it, with no step
  // in between and no first-Space special case.
  await signsIn(page, 'mina')
  await makesASpace(page)

  // ② A machine of theirs connects, and appears without anybody refreshing.
  const machine = await aMachine(await sessionOf(context), 'mina-mbp')
  await machine.poll()
  await expect(page.getByText('mina-mbp')).toBeVisible({ timeout: 15_000 })

  // ③ Pick an agent on it, which is how a conversation starts.
  await page.getByRole('button', { name: /claude code/i }).click()
  await expect(page).toHaveURL(/\/c\//u)

  // ④ Say something. The machine is handed the turn, because it asked for one.
  await page.getByLabel('Say something').fill('where does the timeout live?')
  await page.getByRole('button', { name: 'Send' }).click()
  const first = await waitsForATurn(machine)
  expect(first.asked.map((one) => one.text)).toEqual(['where does the timeout live?'])

  // ⑤ The agent answers, and what it said is on the screen.
  await machine.says(first, { role: 'assistant', content: { text: 'In client.ts, hard-coded.' } })
  await machine.ends(first)
  await expect(page.getByText('In client.ts, hard-coded.')).toBeVisible({ timeout: 15_000 })

  // ⑥ It puts a goal in front of the person — the card, which is a line in the transcript.
  await page.getByLabel('Say something').fill('ok, take it from here')
  await page.getByRole('button', { name: 'Send' }).click()
  const second = await waitsForATurn(machine)
  await machine.says(second, {
    role: 'activity',
    content: { activityType: 'proposed', text: 'Make the 30s timeout configurable' },
  })
  await machine.ends(second)
  await expect(page.getByText('Make the 30s timeout configurable')).toBeVisible({ timeout: 15_000 })

  // ⑦ Hand it over. The rail appears, which is what "you walked away" looks like.
  await page.getByRole('button', { name: 'Hand it over' }).click()
  const rail = page.getByLabel('This piece of work')
  await expect(rail).toBeVisible({ timeout: 15_000 })
  await expect(rail).toContainText('Make the 30s timeout configurable')

  // ⑧ It carries on by itself — a turn it was never asked for — and then asks something.
  const carrying = await waitsForATurn(machine)
  // Through the task endpoint, not by writing a line saying so: what is true now is the ledger's,
  // and a transcript that says "it asked you" changes nothing. This is `handover task wait`.
  await machine.stops(carrying, { state: 'wait', question: 'env var, or a field on the client?' })
  await machine.ends(carrying)
  await expect(rail).toContainText('Waiting on you', { timeout: 15_000 })

  // ⑨ And it is in the Inbox, which is reached from the sidebar and belongs to no Space.
  await page.getByRole('tab', { name: 'Inbox' }).click()
  await expect(page.getByText('env var, or a field on the client?')).toBeVisible({
    timeout: 15_000,
  })
})

test('a machine that goes away stops the page saying it is working', async ({ page, context }) => {
  await signsIn(page, 'rui')
  await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'rui-mbp')
  await machine.poll()
  await page.reload()
  await expect(page.getByText('rui-mbp')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Online')).toBeVisible()

  // Nothing is pushed to a machine, so "gone" is silence for long enough. Moved rather than
  // waited out: what is under test is what the page does with the answer, not the clock.
  await db
    .updateTable('machines')
    .set({ last_seen_at: new Date(Date.now() - 600_000) })
    .where('name', '=', 'rui-mbp')
    .execute()

  await expect(page.getByText(/Offline/u)).toBeVisible({ timeout: 15_000 })
})

/** The session this browser is carrying, which the machine needs to ask for a key. */
async function sessionOf(context: import('@playwright/test').BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  const session = cookies.find((one) => one.name === 'handover_session')
  if (session === undefined) throw new Error('this browser is not signed in')

  return session.value
}

test('what an agent is doing right now reaches a browser that is watching', async ({
  page,
  context,
}) => {
  // The live channel, on its own. Everything else in this suite reads the transcript, which is
  // written down and refetched; this is the half that is kept nowhere and only ever exists on a
  // connection somebody is holding open. A screen test cannot reach it — it fakes `EventSource` —
  // so without this the whole path from a machine to a person's screen is unwalked.
  await signsIn(page, 'ilya')
  await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'ilya-mbp')
  await machine.poll()
  await expect(page.getByText('ilya-mbp')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /claude code/i }).click()
  await expect(page).toHaveURL(/\/c\//u)
  await page.getByLabel('Say something').fill('read notes.txt')
  await page.getByRole('button', { name: 'Send' }).click()
  const turn = await waitsForATurn(machine)

  await machine.happening(turn, { said: 'thinking', text: 'looking for notes.txt' })

  await expect(page.getByText('looking for notes.txt')).toBeVisible({ timeout: 15_000 })
})
