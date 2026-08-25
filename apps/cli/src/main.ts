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
import { keepCheckingIn, reportOnce, type Reported } from './checking-in.ts'
import { askToConnect, connectWithKey, SAID, waitToBeLetIn, type Connected } from './connect.ts'
import { VERSION, machineEnvironment, readEnv } from './env.ts'
import { offering } from './offering.ts'
import { forEveryone, handoverFor, type Step } from './service.ts'
import { attachmentPath, readAttachment, writeAttachment, type Attachment } from './store.ts'

const run = promisify(execFile)

const { values, positionals } = parseArgs({
  options: {
    origin: { type: 'string' },
    name: { type: 'string' },
    system: { type: 'boolean' },
    user: { type: 'boolean' },
    key: { type: 'string' },
    version: { type: 'boolean' },
  },
  allowPositionals: true,
})

const env = readEnv()
const machineName = values.name ?? hostname()

const system = forEveryone(values, process.getuid?.() ?? 1)
const where = attachmentPath(env.configHome, system)
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

/** Cut short when asked to stop, and the timer cleared with it so nothing is left holding on. */
const sleep = async (seconds: number, until?: AbortSignal): Promise<void> =>
  new Promise((wake) => {
    const timer = setTimeout(wake, seconds * 1000)
    until?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        wake()
      },
      { once: true },
    )
  })

if (values.version === true || command === 'version') {
  // The one thing this program says on stdout: asking for the version is asking for a value, and
  // whoever asked is usually a script putting it in a bug report.
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (command === 'connect') {
  await checkIn()
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
  say('try: handover connect   ·   handover run   ·   handover version')
  process.exit(1)
}

/**
 * Makes sure this machine really is in a Space, and says what is on it.
 *
 * A file is not a connection. The credential in it can be taken away while nothing here is
 * running, and the recovery somebody is told for exactly that is this very command — so believing
 * the file would make `connect` say "running" to a machine that is in no Space at all, which is
 * the one thing it must never say.
 *
 * Checking in is the same request as asking whether we are still in, so this costs nothing extra:
 * the answer to the report is the answer to the question.
 */
async function checkIn(): Promise<void> {
  // A key handed in on the command line is somebody saying which Space this machine belongs to
  // now. Believing the file instead would leave the machine where it was and say "connected" —
  // the exact command for moving a machine, doing nothing, quietly.
  const moving = values.key !== undefined
  const held = moving ? undefined : await readAttachment(where)

  if (held !== undefined && (await sayWhatIsHere(held)) !== 'not-ours') return

  await sayWhatIsHere(await enrol())
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
async function askAndWait(origin: string): Promise<Connected> {
  const asked = await askToConnect(apiFor(origin), machineName)
  if (asked === undefined) return { kind: 'gave-up', why: 'unreachable' }

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
async function useKey(origin: string, key: string): Promise<Connected> {
  return connectWithKey(apiFor(origin), origin, key, machineName)
}

/**
 * Says what is on this machine while somebody is still standing in front of it.
 *
 * The same emptiness reaches the Space screen as "no agents found", but by then they are not at
 * this keyboard. Here they can install one and run this again in the same minute.
 */
async function sayWhatIsHere(attachment: Attachment): Promise<Reported['said']> {
  const env = machineEnvironment()
  const reported = await reportOnce(
    apiFor(attachment.origin, attachment.token),
    attachment.lookFor,
    env,
    {
      // Asked here too, so a machine somebody just connected arrives with its model lists already
      // known — rather than the first person to open a conversation on it finding no choice.
      offering: offering(env, process.cwd()),
    },
  )

  for (const line of wordsFor(reported, attachment.lookFor)) say(line)
  return reported.said
}

/** What to say about one report. Pure, so the words are one thing and the asking is another. */
function wordsFor(reported: Reported, lookFor: readonly string[]): readonly string[] {
  if (reported.said === 'not-ours') return ['this machine is not in that Space any more']

  const here =
    reported.found.length === 0
      ? `nothing — install one of ${lookFor.join(', ')} and run this again`
      : reported.found.map((one) => `${one.command} ${one.version}`).join(' · ')

  // "found" on its own reads as "and the Space knows". When nothing was told, it does not.
  return reported.said === 'unreachable'
    ? [`found     ${here}`, '          could not tell the server; it will keep trying']
    : [`found     ${here}`]
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
      args: [entryPoint(), 'run', ...(system ? ['--system'] : ['--user'])],
      system,
      label: 'dev.handover.machine',
      // Taken from this terminal, where it is already right. A service inherits four directories
      // and none of them hold an agent.
      path: machineEnvironment()['PATH'] ?? '',
      // The directory this command was run in, which is the one somebody was told the agent works
      // in. A service starts in `/` unless it is told otherwise.
      where: process.cwd(),
    },
    process.platform,
    homedir(),
  )

  say(`service  ${handover.path}`)
  say(`working  ${process.cwd()}`)

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
    // Where an agent works is where this process is, which the service file set to the directory
    // `connect` was run in. Nobody chooses it, and nothing asks.
    { sleep, say, env: machineEnvironment(), where: process.cwd() },
    stopping.signal,
  )

  if (stopped.kind === 'removed') {
    // Zero, and that is the whole point: `KeepAlive` and `Restart=on-failure` both read a bad
    // exit as "try again", and trying again can never work — the credential is gone. Exiting 1
    // here is a service that comes back every five seconds forever to be told the same thing.
    // A machine told to leave stays gone until somebody connects it again.
    say('this machine was taken out of its Space; connect it again to come back')
    process.exit(0)
  }

  // Said on the way out so the Space shows it gone at once, rather than after the silence runs
  // long enough to count.
  await api.DELETE('/machines/current/session')
  say('stopped')
}
