/**
 * Where this machine keeps what it was given.
 *
 * A file with no one else's permissions, not a keychain: the process that reads it runs unattended
 * under a service manager, and a keychain that prompts is a keychain that never answers.
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Attachment = {
  readonly origin: string
  readonly machineId: string
  readonly token: string
  /**
   * Which commands to look for, as of connecting.
   *
   * Kept so that starting up never has to check in with an empty report just to be told. That
   * report would land as "this machine has nothing", which is briefly untrue and exactly the
   * thing a Space screen would show. Every check-in returns the list again, so it stays current
   * without ever having been guessed.
   */
  readonly lookFor: readonly string[]
}

/**
 * Where it lives depends on who is running.
 *
 * A system service runs as root or a service user and cannot read somebody's home directory, so
 * it keeps its own copy. Two locations rather than one because they belong to two different
 * things, not because one of them is a fallback.
 */
export function attachmentPath(configHome: string | undefined, isSystem: boolean): string {
  if (isSystem) return '/etc/handover/machine.json'

  return join(configHome ?? join(homedir(), '.config'), 'handover', 'machine.json')
}

/**
 * Every field, checked, listed once.
 *
 * `Record<keyof Attachment, …>` is the point: a field added above and not here is a compile
 * error rather than a field nothing ever looks at. Without it this is a rule somebody has to
 * remember, and the thing being guarded against is exactly a file written before a field existed.
 */
const SHAPE: Record<keyof Attachment, (value: unknown) => boolean> = {
  origin: isText,
  machineId: isText,
  token: isText,
  lookFor: (value) => Array.isArray(value) && value.every(isText),
}

function isText(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
}

export async function readAttachment(path: string): Promise<Attachment | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // Never connected, or connected as somebody else. Both mean the same thing to a caller: there
    // is nothing here to be, so ask to come in.
    return undefined
  }

  let found: unknown
  try {
    found = JSON.parse(text)
  } catch {
    // Present but not JSON: returning nothing makes reconnect replace the unusable attachment.
    return undefined
  }

  if (typeof found !== 'object' || found === null) return undefined

  const fields: Record<string, unknown> = { ...found }
  // Not an attachment this version can use — written before a field existed, cut off half way, or
  // edited by hand. Coming in again is the only recovery for any of them, and the same one.
  if (!Object.entries(SHAPE).every(([name, ok]) => ok(fields[name]))) return undefined

  return found as Attachment
}

/**
 * Writes it whole or not at all, and never widens what somebody else can read.
 *
 * Written in place, two things go wrong. A crash part way through leaves a truncated file, which
 * this version cannot use — a machine that was connected reads as one that never was. And an
 * existing file keeps the mode it already had, so a token written into a file that was somehow
 * 0644 is a token anybody on the machine can read until the `chmod` lands.
 *
 * A new file beside it, created 0600 from the first byte, then renamed over: rename is atomic
 * within a directory, so a reader sees either the old attachment or the new one.
 */
export async function writeAttachment(path: string, attachment: Attachment): Promise<void> {
  await mkdir(dirname(path), { recursive: true })

  const beside = `${path}.new`
  const file = await open(beside, 'w', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(attachment, null, 2)}\n`)
    // Before the rename, so what the name ends up pointing at is on the disk and not only in the
    // page cache: a machine that loses power here would otherwise find an empty file.
    await file.sync()
  } finally {
    await file.close()
  }

  try {
    await rename(beside, path)
  } catch (trouble) {
    await unlink(beside).catch(() => {
      // Nothing to clean up, or nothing we can do about it. The old attachment still stands.
    })
    throw trouble
  }
}
