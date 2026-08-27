/**
 * Somebody signing in, for real, in the browser.
 *
 * No session is written into the database and handed over: this types an address, waits for the
 * letter, reads the code out of it and types that. It can, because with no mail provider
 * configured the server refuses to start unless the environment says development out loud — and
 * then it writes each letter to its own log, which is this suite's inbox.
 *
 * The one link nothing here can prove is an email actually leaving the building. Everything on
 * this side of that is walked.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { connect, type Database } from '../apps/server/src/db/connection.ts'
import { loadEnv } from '../apps/server/src/env.ts'

export const db: Database = connect(loadEnv())

const LETTERS = join(import.meta.dirname, 'letters.log')

/** Signs somebody in from the front door, and leaves them where they landed. */
export async function signsIn(page: Page, name: string): Promise<string> {
  const address = `${name}-${randomUUID().slice(0, 8)}@example.com`

  await page.goto('/sign-in')
  await page.getByLabel(/email/i).fill(address)
  await page.getByRole('button', { name: 'Continue' }).click()

  const code = await theCode(address)
  await page.getByLabel(/digit code/i).fill(code)

  // Six digits and nothing to press: the form sends itself, which is the promise being checked.
  await expect(page.getByRole('heading', { name: /workspace|choose a space/i })).toBeVisible({
    timeout: 20_000,
  })

  return address
}

/** Makes a Space from the front door, the way the only way in makes one. */
export async function makesASpace(page: Page): Promise<string> {
  const name = `Acme ${randomUUID().slice(0, 6)}`
  await page.getByLabel(/workspace name/i).fill(name)
  await page.getByRole('button', { name: /continue/i }).click()

  await page.waitForURL(/\/s\//u, { timeout: 20_000 })
  const slug = /\/s\/([^/]+)/u.exec(page.url())?.[1]
  if (slug === undefined) throw new Error(`did not land in a Space: ${page.url()}`)

  return slug
}

/** The newest code sent to this address, read out of the letters the server wrote. */
async function theCode(address: string): Promise<string> {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    const letters = await readFile(LETTERS, 'utf8').catch(() => '')
    const mine = letters
      .split('\n')
      .filter((line) => line.includes(address) && line.includes('plainLetter'))
      .at(-1)
    const code = mine === undefined ? undefined : /\b(\d{6})\b/u.exec(mine)?.[1]
    if (code !== undefined) return code

    await new Promise((wake) => setTimeout(wake, 250))
  }

  throw new Error(`no letter arrived for ${address}`)
}
