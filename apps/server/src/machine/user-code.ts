/**
 * The short code somebody reads off one screen and types into another.
 *
 * It travels through a person: copied onto a sticky note, read down a phone, squinted at across a
 * server rack. That is the whole reason the alphabet is what it is, and why anything a person
 * might reasonably add — spaces, extra dashes, lower case — has to be accepted back.
 */

import { randomInt } from 'node:crypto'

/**
 * RFC 8628's alphabet: case-insensitive A–Z with no digits, minus the vowels.
 *
 * No digits means no `0`/`O` and no `1`/`I` to confuse, without listing exclusions one by one.
 * No vowels means it cannot spell a word — nobody should have to read an obscenity down a phone
 * to connect their laptop.
 */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

const LETTERS = 8

/** Grouped for reading aloud and for finding your place again after looking away. */
const GROUP = 4

/** The whole of what makes a string a code: those letters, that many, nothing else. */
const SHAPE = new RegExp(`^[${ALPHABET}]{${String(LETTERS)}}$`, 'u')

/**
 * A code somebody has been shown, in the one form it is stored and compared in.
 *
 * Branded so a raw string cannot be looked up by mistake: what a person typed is not this until
 * it has been through {@link readUserCode}.
 */
export type UserCode = string & { readonly __brand: 'UserCode' }

export function newUserCode(): UserCode {
  const letters = Array.from(
    { length: LETTERS },
    () => ALPHABET[randomInt(ALPHABET.length)] as string,
  ).join('')

  return `${letters.slice(0, GROUP)}-${letters.slice(GROUP)}` as UserCode
}

/**
 * What somebody typed, as a code — or nothing, if it is not one.
 *
 * Case, spaces and dashes are all noise a person adds: `wdjb mjht` and `WDJB-MJHT` are the same
 * code, and refusing either would be refusing somebody who read it correctly.
 */
export function readUserCode(typed: string): UserCode | undefined {
  const letters = typed.toUpperCase().replaceAll(/[\s-]/gu, '')
  if (!SHAPE.test(letters)) return undefined

  return `${letters.slice(0, GROUP)}-${letters.slice(GROUP)}` as UserCode
}
