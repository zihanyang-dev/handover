import { describe, expect, it } from 'vitest'
import { newUserCode, readUserCode } from './user-code.ts'

/** Enough draws that a letter appearing once in twenty is very unlikely to be missed. */
function manyCodes(): readonly string[] {
  return Array.from({ length: 500 }, () => newUserCode())
}

describe('the code somebody reads off one screen', () => {
  it('is eight letters in two groups', () => {
    expect(newUserCode()).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u)
  })

  it('never contains a digit, so there is no 0 against O and no 1 against I', () => {
    expect(manyCodes().join('')).not.toMatch(/\d/u)
  })

  it('never contains a vowel, so it cannot spell a word somebody has to read aloud', () => {
    expect(manyCodes().join('')).not.toMatch(/[AEIOU]/u)
  })

  it('does not hand out the same one twice in a row', () => {
    // Not a strength claim — 20^8 is where that lives. This catches a generator that forgot to
    // draw again, which is the way this breaks in practice.
    expect(new Set(manyCodes()).size).toBeGreaterThan(400)
  })
})

describe('reading back what somebody typed', () => {
  it('takes it exactly as it was shown', () => {
    expect(readUserCode('WDJB-MJHT')).toBe('WDJB-MJHT')
  })

  it('takes it lower case, because nobody types the case they were shown', () => {
    expect(readUserCode('wdjb-mjht')).toBe('WDJB-MJHT')
  })

  it.each([
    ['no dash', 'WDJBMJHT'],
    ['a space instead', 'WDJB MJHT'],
    ['spaces around it', '  WDJB-MJHT  '],
    ['dashes of their own', 'WD-JB-MJ-HT'],
  ])('takes it with %s, because that is somebody reading it correctly', (_, typed) => {
    expect(readUserCode(typed)).toBe('WDJB-MJHT')
  })

  it.each([
    ['too short', 'WDJB-MJH'],
    ['too long', 'WDJB-MJHTX'],
    ['a vowel', 'WDJB-MJHA'],
    ['a digit', 'WDJB-MJH0'],
    ['nothing at all', ''],
  ])('refuses %s', (_, typed) => {
    expect(readUserCode(typed)).toBeUndefined()
  })

  it('reads back everything it hands out', () => {
    // The two halves are one rule. A generator that drifted from the reader would produce codes
    // that are correct and rejected, and the person holding one would have no way to tell.
    const unreadable = manyCodes().filter((code) => readUserCode(code) !== code)

    expect(unreadable).toEqual([])
  })
})
