/**
 * Where this machine keeps what it was given.
 *
 * A file with no one else's permissions, not a keychain: the process that reads it runs unattended
 * under a service manager, and a keychain that prompts is a keychain that never answers.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  const found: unknown = await readFile(path, 'utf8')
    .then((text): unknown => JSON.parse(text))
    // Never connected, or connected as somebody else. Both mean the same thing to a caller: there
    // is nothing here to be, so ask to come in.
    .catch(() => undefined)

  if (typeof found !== 'object' || found === null) return undefined

  const fields: Record<string, unknown> = { ...found }
  // Not an attachment this version can use — written before a field existed, cut off half way, or
  // edited by hand. Coming in again is the only recovery for any of them, and the same one.
  if (!Object.entries(SHAPE).every(([name, ok]) => ok(fields[name]))) return undefined

  return found as Attachment
}

export async function writeAttachment(path: string, attachment: Attachment): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(attachment, null, 2)}\n`, { mode: 0o600 })
  // Set again: an existing file keeps the permissions it already had, and this one may be one we
  // wrote before with a wider mode.
  await chmod(path, 0o600)
}
