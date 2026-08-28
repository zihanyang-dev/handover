/**
 * The journey `prd.md` 04 describes, walked in a browser.
 *
 * Everything here is the shipped thing: the built app, one origin, the real routes, a real
 * Postgres. The one stand-in is the agent process — see `a-machine.ts` for why, and where the
 * real agents are tested instead.
 *
 * What this is for is the half no unit test reaches: that the screens, the API and the machine
 * protocol agree about the same conversation at the same time.
 *
 * What it no longer walks is what the rebuilt app no longer shows. Handing a conversation over,
 * the rail that a piece of work lives in, inviting somebody, and managing who is in a Space all
 * have working server sides and no screen — `rules/reachable.spec.ts` keeps that list, and the
 * behaviour itself is proven in `apps/server/src/db` and `apps/server/src/server`.
 */

import { expect, test } from '@playwright/test'
import { aMachine, waitsForATurn } from './a-machine.ts'
import { connects, makesASpace, signsIn } from './someone.ts'

const db = connects()

test.afterAll(async () => {
  await db.destroy()
})

test('talk to an agent, and read what it answers', async ({ page, context }) => {
  // ① Sign in from the front door and make a Space — which lands straight in it, with no first
  // Space special case, and offers to connect a machine on the way.
  await signsIn(page, 'mina')
  await makesASpace(page)

  // ② A machine of theirs connects, and its agents appear without anybody refreshing.
  const machine = await aMachine(await sessionOf(context), 'mina-mbp')
  await machine.poll()
  await picks(page, 'mina-mbp')

  // ③ Saying the first thing is what opens a conversation — there is no way to make an empty one.
  await page.getByLabel(/^Message /u).fill('where does the timeout live?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(/\/c\//u)

  // ④ The machine is handed that turn, because it asked for one.
  const first = await waitsForATurn(machine)
  expect(first.asked.map((one) => one.text)).toEqual(['where does the timeout live?'])

  // ⑤ The agent answers, and what it said is on the screen.
  await machine.says(first, { role: 'assistant', content: { text: 'In client.ts, hard-coded.' } })
  await machine.ends(first)
  await expect(page.getByText('In client.ts, hard-coded.')).toBeVisible({ timeout: 15_000 })

  // ⑥ And saying something into the conversation that already exists reaches the same agent.
  await page.getByLabel('Message agent').fill('and on retries?')
  await page.getByRole('button', { name: 'Send' }).click()
  const second = await waitsForATurn(machine)
  expect(second.asked.map((one) => one.text)).toEqual(['and on retries?'])
})

test('a machine that goes away stops the page saying its agent is ready', async ({
  page,
  context,
}) => {
  await signsIn(page, 'rui')
  await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'rui-mbp')
  await machine.poll()
  await page.reload()
  await page.getByRole('button', { name: 'Chat' }).click()
  await expect(page.getByRole('link', { name: /on rui-mbp, ready/iu })).toBeVisible({
    timeout: 15_000,
  })

  // Nothing is pushed to a machine, so "gone" is silence for long enough. Moved rather than
  // waited out: what is under test is what the page does with the answer, not the clock.
  await db
    .updateTable('machines')
    .set({ last_seen_at: new Date(Date.now() - 600_000) })
    .where('name', '=', 'rui-mbp')
    .execute()

  await expect(page.getByRole('link', { name: /on rui-mbp, offline/iu })).toBeVisible({
    timeout: 15_000,
  })
})

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
  await picks(page, 'ilya-mbp')

  await page.getByLabel(/^Message /u).fill('read notes.txt')
  await page.getByRole('button', { name: 'Send' }).click()
  const turn = await waitsForATurn(machine)

  // Said over and over, because a moment is kept nowhere: the conversation is created by sending
  // its first message, so the browser arrives on it at the same instant the machine is handed the
  // turn, and one sent before that browser had opened its stream would simply be gone. A real
  // agent says what it is doing continuously, which is what this imitates.
  const saying = setInterval(() => {
    void machine.happening(turn, { said: 'thinking', text: 'looking for notes.txt' })
  }, 500)
  try {
    await expect(page.getByLabel('Happening now')).toContainText('looking for notes.txt', {
      timeout: 15_000,
    })
  } finally {
    clearInterval(saying)
  }
})

/** Chooses the agent on that machine, which is what opens a composer to say the first thing to. */
async function picks(page: import('@playwright/test').Page, machineName: string): Promise<void> {
  await page.getByRole('button', { name: 'Chat' }).click()
  const agent = page.getByRole('link', { name: new RegExp(`on ${machineName}, ready`, 'iu') })
  await expect(agent).toBeVisible({ timeout: 15_000 })
  await agent.click()
  await expect(page).toHaveURL(/\/a\//u)
}

/** The session this browser is carrying, which the machine needs to ask for a key. */
async function sessionOf(context: import('@playwright/test').BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  const session = cookies.find((one) => one.name === 'handover_session')
  if (session === undefined) throw new Error('this browser is not signed in')

  return session.value
}
