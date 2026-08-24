#!/usr/bin/env node
/**
 * The command a person runs on the machine they want to connect.
 *
 * `connect` does the whole thing, including handing the machine to whatever keeps things running
 * here, so closing the terminal is not the end of it. `run` is the same work in the foreground
 * with nothing installed, for finding out why something is not working.
 *
 * Nothing here forks, writes a pid file, or decides when to restart. Those belong to a service
 * manager and it is better at all three; a program that does them itself ends up owning a worse
 * copy of one, along with the questions that come with it.
 */

import { execFile } from 'node:child_process'
import { hostname, homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { apiFor } from './api.ts'
import { keepCheckingIn } from './checking-in.ts'
import { askToConnect, connectWithKey, waitToBeLetIn } from './connect.ts'
import { machineEnvironment, readEnv } from './env.ts'
import { findAgents } from './discovery.ts'
import { handoverFor } from './service.ts'
import { attachmentPath, readAttachment, writeAttachment, type Attachment } from './store.ts'

const run = promisify(execFile)

const { values, positionals } = parseArgs({
  options: {
    origin: { type: 'string' },
    name: { type: 'string' },
    system: { type: 'boolean', default: false },
    key: { type: 'string' },
  },
  allowPositionals: true,
})

const env = readEnv()
const machineName = values.name ?? hostname()
const where = attachmentPath(env.configHome, values.system)
const command = positionals[0] ?? 'connect'

/** Straight to stderr: stdout belongs to whatever a person might want to pipe. */
function say(line: string): void {
  process.stderr.write(`${line}\n`)
}

const sleep = async (seconds: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, seconds * 1000))

if (command === 'connect') {
  const attachment = (await readAttachment(where)) ?? (await enrol())
  await sayWhatIsHere(attachment)
  await handOver()
} else if (command === 'run') {
  const attachment = await readAttachment(where)
  if (attachment === undefined) {
    say('this machine is not connected yet; run `handover connect` first')
    process.exit(1)
  }
  await stayConnected(attachment)
} else {
  say(`no such command: ${command}`)
  say('try: handover connect   ·   handover run')
  process.exit(1)
}

async function enrol(): Promise<Attachment> {
  const origin = values.origin ?? env.origin
  const connected =
    values.key === undefined ? await askAndWait(origin) : await useKey(origin, values.key)

  if (connected.kind === 'gave-up') {
    say(`did not get in: ${connected.why}`)
    process.exit(1)
  }

  await writeAttachment(where, connected.attachment)
  say(`connected as ${machineName}`)
  return connected.attachment
}

/** The way in for a machine somebody is sitting at: show a code, wait for them to say yes. */
async function askAndWait(origin: string) {
  const asked = await askToConnect(apiFor(origin), machineName)

  return waitToBeLetIn(apiFor(origin), origin, asked, {
    show: (shown) => {
      say(`open  ${shown.verifyUrl}`)
      say(`code  ${shown.userCode}`)
      say('')
      say(`or open  ${shown.verifyUrlComplete}`)
    },
    sleep,
  })
}

/** The way in for a machine with no browser: the approving already happened, in a Space. */
async function useKey(origin: string, key: string) {
  return connectWithKey(apiFor(origin), origin, key, machineName)
}

/**
 * Says what is on this machine while somebody is still standing in front of it.
 *
 * The same emptiness reaches the Space screen as "no agents found", but by then they are not at
 * this keyboard. Here they can install one and run this again in the same minute.
 */
async function sayWhatIsHere(attachment: Attachment): Promise<void> {
  const api = apiFor(attachment.origin, attachment.token)
  const { data } = await api.POST('/machines/current/poll', { body: { found: [] } })
  const found = await findAgents(data?.lookFor ?? [], machineEnvironment())

  if (found.length === 0) {
    say(`found     nothing — install one of ${(data?.lookFor ?? []).join(', ')} and run this again`)
    return
  }

  say(`found     ${found.map((one) => `${one.command} ${one.version}`).join(' · ')}`)
}

/**
 * Writes the service file and runs what makes it take effect, saying both first.
 *
 * The path is printed whether or not this works, because a machine somebody cannot find the
 * service for is one they cannot change, look at, or turn off without guessing.
 */
async function handOver(): Promise<void> {
  const handover = handoverFor(
    {
      // Absolute, and never resolved through a shell: a typo in a profile must not be able to
      // stop a service from starting.
      executable: process.execPath,
      args: [process.argv[1] ?? '', 'run', ...(values.system ? ['--system'] : [])],
      system: values.system,
      label: 'dev.handover.machine',
      // Taken from this terminal, where it is already right. A service inherits four directories
      // and none of them hold an agent.
      path: machineEnvironment()['PATH'] ?? '',
    },
    process.platform,
    homedir(),
  )

  say(`service  ${handover.path}`)

  await mkdir(dirname(handover.path), { recursive: true })
  await writeFile(handover.path, handover.contents)

  for (const step of handover.steps) {
    say(`         ${step.join(' ')}`)
    await run(step[0] ?? '', step.slice(1))
  }

  say('running. closing this terminal will not stop it.')
}

async function stayConnected(attachment: Attachment): Promise<void> {
  const stopping = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping.abort()
    })
  }

  const api = apiFor(attachment.origin, attachment.token)
  const first = await api.POST('/machines/current/poll', { body: { found: [] } })

  // The PATH here is the one the service file carries, put there by `connect`.
  const stopped = await keepCheckingIn(
    api,
    first.data?.lookFor ?? [],
    { sleep, say, env: machineEnvironment() },
    stopping.signal,
  )

  if (stopped.kind === 'removed') {
    say('this machine was taken out of its Space; connect it again to come back')
    process.exit(1)
  }

  // Said on the way out so the Space shows it gone at once, rather than after the silence runs
  // long enough to count.
  await api.DELETE('/machines/current/session')
  say('stopped')
}
