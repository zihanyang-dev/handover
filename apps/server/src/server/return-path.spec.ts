import { describe, expect, it } from 'vitest'
import { returnPath } from './return-path.ts'

const WEB = 'https://app.handover.test'
const back = (asked: string | undefined) => returnPath(asked, WEB)

describe('returnPath', () => {
  it('keeps a path on this site', () => {
    expect(back('/s/acme')).toBe('/s/acme')
    expect(back('/s/acme?tab=work#top')).toBe('/s/acme?tab=work#top')
  })

  it('sends the front door when nothing was asked for', () => {
    expect(back(undefined)).toBe('/')
    expect(back('')).toBe('/')
  })

  it('refuses another origin', () => {
    expect(back('https://evil.example.com/login')).toBe('/')
    expect(back('http://evil.example.com')).toBe('/')
  })

  it('refuses the protocol-relative forms a browser still reads as another origin', () => {
    expect(back('//evil.example.com')).toBe('/')
    expect(back('/\\evil.example.com')).toBe('/')
  })

  it('refuses a scheme that runs something', () => {
    expect(back('javascript:alert(1)')).toBe('/')
    expect(back('data:text/html,<script>')).toBe('/')
  })

  it('refuses what a browser reads as another origin after it strips the whitespace', () => {
    // The browser removes tabs and newlines before parsing, so these start with a slash to a
    // reader and are somebody else's site to the thing that follows them. Every check written
    // against the characters is a check the browser has already undone.
    for (const sneaky of [
      '/\t/evil.example.com/x',
      '/\n/evil.example.com/x',
      '/\r/evil.example.com/x',
    ]) {
      expect(new URL(sneaky, WEB).origin, `${JSON.stringify(sneaky)} is another origin`).not.toBe(
        WEB,
      )
      expect(back(sneaky)).toBe('/')
    }
  })

  it('keeps a path whose own characters merely look odd', () => {
    expect(back('/s/徐悦泰')).toBe('/s/%E5%BE%90%E6%82%A6%E6%B3%B0')
  })
})
