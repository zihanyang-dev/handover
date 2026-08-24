import { describe, expect, it } from 'vitest'
import { returnPath } from './return-path.ts'

describe('returnPath', () => {
  it('keeps a path on this site', () => {
    expect(returnPath('/s/acme')).toBe('/s/acme')
    expect(returnPath('/s/acme?tab=work#top')).toBe('/s/acme?tab=work#top')
  })

  it('sends the front door when nothing was asked for', () => {
    expect(returnPath(undefined)).toBe('/')
    expect(returnPath('')).toBe('/')
  })

  it('refuses another origin', () => {
    expect(returnPath('https://evil.example.com/login')).toBe('/')
    expect(returnPath('http://evil.example.com')).toBe('/')
  })

  it('refuses the protocol-relative forms a browser still reads as another origin', () => {
    expect(returnPath('//evil.example.com')).toBe('/')
    expect(returnPath('/\\evil.example.com')).toBe('/')
  })

  it('refuses a scheme that runs something', () => {
    expect(returnPath('javascript:alert(1)')).toBe('/')
    expect(returnPath('data:text/html,<script>')).toBe('/')
  })
})
