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

export async function readAttachment(path: string): Promise<Attachment | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Attachment
  } catch {
    // Never connected, or connected as somebody else. Both mean the same thing to a caller: there
    // is nothing here to be, so ask to come in.
    return undefined
  }
}

export async function writeAttachment(path: string, attachment: Attachment): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(attachment, null, 2)}\n`, { mode: 0o600 })
  // Set again: an existing file keeps the permissions it already had, and this one may be one we
  // wrote before with a wider mode.
  await chmod(path, 0o600)
}
