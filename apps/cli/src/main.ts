#!/usr/bin/env node
/**
 * The command a person runs on the machine they want to connect.
 *
 * It runs in the foreground and stays there. Nothing here forks, writes a pid file or invents a
 * log directory: staying alive across a logout or a reboot is what a service manager is for, and
 * a program that does it itself ends up owning a worse copy of one.
 */

import { parseArgs } from 'node:util'
import { hostname } from 'node:os'
import { apiFor } from './api.ts'
import { askToConnect, waitToBeLetIn } from './connect.ts'
import { keepCheckingIn } from './checking-in.ts'
import { machineEnvironment, readEnv } from './env.ts'
import { attachmentPath, readAttachment, writeAttachment } from './store.ts'

const { values } = parseArgs({
  options: {
    origin: { type: 'string' },
    name: { type: 'string' },
    system: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

const env = readEnv()
const origin = values.origin ?? env.origin
const where = attachmentPath(env.configHome, values.system)

const sleep = async (seconds: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, seconds * 1000))

const stopping = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping.abort()
  })
}

const existing = await readAttachment(where)
const attachment = existing ?? (await enrol())

const api = apiFor(attachment.origin, attachment.token)
const stopped = await keepCheckingIn(
  api,
  await lookForNow(),
  { sleep, say: report, env: machineEnvironment() },
  stopping.signal,
)

if (stopped.kind === 'removed') {
  report('this machine was taken out of its Space; connect it again to come back')
  process.exit(1)
}

// Said on the way out so the Space shows it gone at once, rather than after the silence runs long
// enough to count.
await api.DELETE('/machines/current/session')
report('stopped')

async function enrol() {
  const asked = await askToConnect(apiFor(origin), values.name ?? hostname())

  const connected = await waitToBeLetIn(apiFor(origin), origin, asked, {
    show: (shown) => {
      report(`open  ${shown.verifyUrl}`)
      report(`code  ${shown.userCode}`)
      report('')
      report(`or open  ${shown.verifyUrlComplete}`)
    },
    sleep,
  })

  if (connected.kind === 'gave-up') {
    report(`did not get in: ${connected.why}`)
    process.exit(1)
  }

  await writeAttachment(where, connected.attachment)
  report(`connected as ${values.name ?? hostname()}`)
  return connected.attachment
}

/**
 * What to look for on the very first pass.
 *
 * A machine that just connected was told; one starting again from a stored credential asks. Both
 * come from the server, so neither carries a list that could be older than the one it reports to.
 */
async function lookForNow(): Promise<readonly string[]> {
  const { data } = await api.POST('/machines/current/poll', { body: { found: [] } })
  return data?.lookFor ?? []
}

/** Straight to stderr: stdout belongs to whatever a person might want to pipe. */
function report(line: string): void {
  process.stderr.write(`${line}\n`)
}
