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
 * Administration and handing work over are walked here as browser actions too: no endpoint counts
 * as delivered merely because a tested hook contains its path.
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
  const slug = await makesASpace(page)

  // ② A machine of theirs connects, and its agents appear without anybody refreshing.
  const machine = await aMachine(await sessionOf(context), 'mina-mbp', slug)
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
  await page.getByLabel(/^Message /u).fill('and on retries?')
  await page.getByRole('button', { name: 'Send' }).click()
  const second = await waitsForATurn(machine)
  expect(second.asked.map((one) => one.text)).toEqual(['and on retries?'])
})

test('a machine that goes away stops the page saying its agent is ready', async ({
  page,
  context,
}) => {
  await signsIn(page, 'rui')
  const slug = await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'rui-mbp', slug)
  await machine.poll()
  await page.reload()
  await page.getByRole('tab', { name: 'Chat' }).click()
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

test('a machine owner changes agent settings and disconnects it', async ({ page, context }) => {
  await signsIn(page, 'machine-owner')
  const slug = await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'settings-mbp', slug)
  await machine.poll()

  await openSpaceSettings(page)
  await page.getByRole('tab', { name: 'Account' }).click()
  await page.setViewportSize({ width: 400, height: 800 })
  await expect(page.getByRole('heading', { name: 'Your machines' })).toBeVisible()
  const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth')
  expect(scrollWidth).toBeLessThanOrEqual(400)
  await expect(page.getByText('settings-mbp')).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Name', { exact: true }).fill('Runner')
  const atOnce = page.getByLabel('At once')
  await atOnce.fill('4')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/agents/'),
  )
  await atOnce.press('Tab')
  await saved
  await page.getByRole('button', { name: 'Close settings' }).click()

  await openSpaceSettings(page)
  await page.getByRole('tab', { name: 'Account' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Runner')
  await expect(page.getByLabel('At once')).toHaveValue('4')
  await page.getByRole('button', { name: 'Disconnect machine' }).click()
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByText('You have not connected a machine yet.')).toBeVisible({
    timeout: 15_000,
  })
})

test('hand work over, find its question in Inbox, and take it back', async ({ page, context }) => {
  await signsIn(page, 'handover-owner')
  const slug = await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'handover-mbp', slug)
  await machine.poll()
  await picks(page, 'handover-mbp')

  await page.getByLabel(/^Message /u).fill('make the timeout configurable')
  await page.getByRole('button', { name: 'Send' }).click()
  const first = await waitsForATurn(machine)
  const goal = 'Make the timeout configurable and keep the default at 30 seconds'
  await machine.says(first, {
    role: 'activity',
    content: { activityType: 'proposed', text: goal },
  })
  await machine.ends(first)

  const proposal = page.getByRole('article', { name: 'Proposed handover' })
  await expect(proposal).toContainText(goal, { timeout: 15_000 })
  await proposal.getByRole('button', { name: 'Hand over' }).click()
  await expect(page.getByRole('heading', { name: 'Piece of work' })).toBeVisible({
    timeout: 15_000,
  })

  // Stopping this Space from using the machine would strand this exact work. The confirmation
  // must name it before the relationship is changed, not make the interruption discoverable only
  // after the agent stops answering.
  await openSpaceSettings(page)
  await page.getByRole('tab', { name: 'Machines' }).click()
  await page.getByRole('button', { name: /^Stop sharing with /u }).click()
  await expect(page.getByRole('heading', { name: 'Work still using this machine' })).toBeVisible()
  await expect(page.getByRole('link', { name: goal })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()

  const autonomous = await waitsForATurn(machine)
  await machine.stops(autonomous, {
    state: 'wait',
    question: 'Should the setting be milliseconds or seconds?',
  })
  await machine.ends(autonomous)

  const conversationUrl = page.url()
  await page.getByRole('tab', { name: 'Inbox' }).click()
  await expect(page).toHaveURL(conversationUrl)
  const inbox = page.getByRole('tabpanel', { name: 'Inbox' })
  await expect(inbox.getByRole('heading', { name: 'Waiting on you' })).toBeVisible({
    timeout: 15_000,
  })
  const waiting = inbox.getByRole('link').filter({ hasText: goal })
  await expect(waiting).toContainText('Should the setting be milliseconds or seconds?')
  await waiting.click()

  await expect(page.getByRole('heading', { name: 'Piece of work' })).toBeVisible()
  await page.getByRole('button', { name: 'Take back' }).click()
  await page.getByRole('button', { name: 'Take back work' }).click()
  await expect(page.getByRole('heading', { name: 'Piece of work' })).not.toBeVisible({
    timeout: 15_000,
  })
})

test('a resized sidebar still closes at 320 CSS pixels', async ({ page }) => {
  await signsIn(page, 'narrow')
  await makesASpace(page)

  const resize = page.getByRole('separator', { name: /resize with left and right/i })
  await resize.focus()
  for (let step = 0; step < 30; step += 1) await resize.press('ArrowRight')

  await page.setViewportSize({ width: 320, height: 720 })
  const close = page.getByRole('button', { name: 'Close sidebar' })
  await expect(close).toBeVisible()
  await close.click()
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible()
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
  const slug = await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'ilya-mbp', slug)
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
    void machine.happening(turn, {
      said: 'doing',
      callId: 'read-notes',
      name: 'Read',
      verb: 'Reading',
      arg: 'notes.txt',
    })
  }, 500)
  try {
    await expect(page.getByLabel('Happening now')).toContainText('Reading notes.txt', {
      timeout: 15_000,
    })
  } finally {
    clearInterval(saying)
  }
})

async function openSpaceSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Open .* menu/u }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
}

/** Chooses the agent on that machine, which is what opens a composer to say the first thing to. */
async function picks(page: import('@playwright/test').Page, machineName: string): Promise<void> {
  await page.getByRole('tab', { name: 'Chat' }).click()
  const agent = page.getByRole('link', {
    name: `Claude Code on ${machineName}, ready`,
    exact: true,
  })
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

test('a plan you can watch, and watch change', async ({ page, context }) => {
  await signsIn(page, 'mina')
  const slug = await makesASpace(page)
  const machine = await aMachine(await sessionOf(context), 'planning-mbp', slug)
  await machine.poll()
  await picks(page, 'planning-mbp')

  await page.getByLabel(/^Message /u).fill('add retries to the client')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(/\/c\//u)

  const turn = await waitsForATurn(machine)

  // ① It sets out what it means to do, and the page says how far along without being opened.
  await machine.says(turn, {
    role: 'activity',
    content: {
      activityType: 'planned',
      steps: [
        { text: 'read the client', state: 'done' },
        { text: 'add the retry loop', state: 'doing' },
        { text: 'write a test', state: 'waiting' },
      ],
    },
  })
  await expect(page.getByRole('region', { name: 'Plan' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('1 of 3')).toBeVisible()
  // The step itself, not the word "working": what it is doing is the thing worth a glance.
  await expect(page.getByText('add the retry loop')).toBeVisible()

  // ② It changes its mind. The page shows the plan it is working to now, not the one it opened
  //    with — which is the whole reason this is pinned rather than left in the transcript.
  await machine.says(turn, {
    role: 'activity',
    content: {
      activityType: 'planned',
      steps: [
        { text: 'read the client', state: 'done' },
        { text: 'add the retry loop', state: 'done' },
        { text: 'back off between tries', state: 'doing' },
        { text: 'write a test', state: 'waiting' },
      ],
    },
  })
  await expect(page.getByText('2 of 4')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('back off between tries')).toBeVisible()

  // ③ Closed by default, and the whole of it is one click away.
  await page.getByRole('button', { name: /of 4/u }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'write a test' })).toBeVisible()

  // ④ Both versions are still in the transcript, in the order they happened — which is what says
  //    it changed its mind rather than always having meant this.
  await expect(page.getByText('It set out what it means to do')).toHaveCount(2)
})
