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
import { askToConnect, connectWithKey, SAID, waitToBeLetIn } from './connect.ts'
import { machineEnvironment, readEnv } from './env.ts'
import { findAgents } from './discovery.ts'
import { handoverFor, type Step } from './service.ts'
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

/** Long enough for any throttle a service manager holds a name through, short enough to give up in. */
const PATIENCE_SECONDS = 30

/**
 * This program's own path, for the service file to point at.
 *
 * Loud when it is missing rather than written as an empty argument: a service whose command is
 * half-formed starts, does nothing, and says nothing about why.
 */
function entryPoint(): string {
  const here = process.argv[1]
  if (here === undefined) throw new Error('cannot tell where this program lives')
  return here
}

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
  const key = values.key
  const connected = key === undefined ? await askAndWait(origin) : await useKey(origin, key)

  if (connected.kind === 'gave-up') {
    // Which door was used decides the words, because it decides what there is to do next.
    say(`did not get in — ${SAID[key === undefined ? 'code' : 'key'][connected.why]}`)
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
  const found = await findAgents(attachment.lookFor, machineEnvironment())

  // Reported as it is said, not after. Checking in with an empty report first — just to be told
  // what to look for — would land on the Space screen as a machine that has nothing.
  await apiFor(attachment.origin, attachment.token).POST('/machines/current/poll', {
    body: { found },
  })

  if (found.length === 0) {
    say(`found     nothing — install one of ${attachment.lookFor.join(', ')} and run this again`)
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
      args: [entryPoint(), 'run', ...(values.system ? ['--system'] : [])],
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
    switch (step.need) {
      case 'do-it':
        say(`         ${step.run.join(' ')}`)
        await attempt(step)
        break
      case 'clear-it':
        // Nothing to clear is what running `connect` on a fresh machine looks like.
        await works(step)
        break
      case 'wait-out':
        await waitOut(step)
        break
    }
  }

  say('running. closing this terminal will not stop it.')
}

async function attempt(step: Step): Promise<void> {
  const [program, ...rest] = step.run
  await run(program, rest)
}

/** Whether a step exits cleanly. For the two needs where failing is an answer rather than an error. */
async function works(step: Step): Promise<boolean> {
  return attempt(step).then(
    () => true,
    () => false,
  )
}

/**
 * Runs a check until it fails, which is the thing being waited for.
 *
 * It says so once it has waited at all, because the wait is measured in seconds and a command
 * that goes quiet for five of them looks like one that has stopped.
 */
async function waitOut(step: Step): Promise<void> {
  const giveUpAt = Date.now() + PATIENCE_SECONDS * 1000
  let said = false

  while (await works(step)) {
    if (!said) {
      say('         waiting for the one already running to stop')
      said = true
    }
    if (Date.now() > giveUpAt) {
      throw new Error(
        `gave up after ${String(PATIENCE_SECONDS)}s: ${step.run.join(' ')} still works`,
      )
    }
    await sleep(0.25)
  }
}

async function stayConnected(attachment: Attachment): Promise<void> {
  const stopping = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping.abort()
    })
  }

  const api = apiFor(attachment.origin, attachment.token)

  // Starts from what connecting was told, so the first check-in already carries findings. Every
  // answer returns the list again, so it follows the server without ever having been guessed.
  // The PATH is the one the service file carries, put there by `connect`.
  const stopped = await keepCheckingIn(
    api,
    attachment.lookFor,
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
