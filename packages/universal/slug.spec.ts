import { describe, expect, it } from 'vitest'
import { nextFreeSlug, normalizeSlug, type Slug } from './slug.ts'

describe('normalizeSlug', () => {
  it('lowercases and joins words with one separator', () => {
    expect(normalizeSlug('Acme Corp')).toBe('acme-corp')
  })

  it('collapses surrounding and repeated whitespace', () => {
    expect(normalizeSlug('   Hello   World   ')).toBe('hello-world')
  })

  it('collapses punctuation into a single separator and drops it at the edges', () => {
    expect(normalizeSlug('C++ / Rust')).toBe('c-rust')
    expect(normalizeSlug('--Acme--')).toBe('acme')
  })

  it('keeps non-ASCII names as they are', () => {
    expect(normalizeSlug('徐悦泰')).toBe('徐悦泰')
    expect(normalizeSlug('徐悦泰 Studio')).toBe('徐悦泰-studio')
  })

  it('folds the full-width Latin a CJK keyboard produces', () => {
    expect(normalizeSlug('Ａｃｍｅ')).toBe('acme')
  })

  it('returns null when nothing usable survives', () => {
    expect(normalizeSlug('!!!')).toBeNull()
    expect(normalizeSlug('   ')).toBeNull()
    expect(normalizeSlug('')).toBeNull()
  })

  it('clips a long name without leaving a trailing separator', () => {
    const slug = normalizeSlug(`${'a'.repeat(63)} tail`)

    expect(slug).toBe('a'.repeat(63))
    expect(slug).not.toContain('-')
  })

  it('clips by character, never through the middle of one', () => {
    expect(normalizeSlug('字'.repeat(100))).toBe('字'.repeat(64))
  })

  it('composes a mark into the letter when Unicode has a single character for it', () => {
    expect(normalizeSlug('e\u0301')).toBe('\u00e9')
  })

  it('keeps a mark with its letter when Unicode has no single character for it', () => {
    // "a" plus U+0334 stays two code points, so clipping by code point would cut between them.
    const slug = normalizeSlug('a\u0334'.repeat(70))

    expect(slug).toBe('a\u0334'.repeat(64))
    expect(Array.from(slug ?? '')).toHaveLength(128)
  })

  it('gives the same answer to the browser and the server', () => {
    const name = '  Ａcme   Corp!!  '

    expect(normalizeSlug(name)).toBe(normalizeSlug(normalizeSlug(name) ?? ''))
  })
})

describe('nextFreeSlug', () => {
  const base = 'acme' as Slug

  it('starts at two, because the first one needs no number', () => {
    expect(nextFreeSlug(base, ['acme'])).toBe('acme-2')
  })

  it('skips the numbers already in use', () => {
    expect(nextFreeSlug(base, ['acme', 'acme-2', 'acme-3'])).toBe('acme-4')
  })

  it('fills a gap rather than counting past it', () => {
    expect(nextFreeSlug(base, ['acme', 'acme-2', 'acme-5'])).toBe('acme-3')
  })

  it('ignores names that only look related', () => {
    expect(nextFreeSlug(base, ['acme-corp', 'acmex-2'])).toBe('acme-2')
  })

  it('numbers a non-ASCII name the same way', () => {
    expect(nextFreeSlug('徐悦泰' as Slug, ['徐悦泰'])).toBe('徐悦泰-2')
  })
})
