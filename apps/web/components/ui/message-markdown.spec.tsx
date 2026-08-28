import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageMarkdown } from './message-markdown.tsx'

afterEach(cleanup)

describe('message markdown', () => {
  it('keeps raw HTML as text rather than executable DOM', () => {
    render(<MessageMarkdown>{'<script>alert("no")</script>'}</MessageMarkdown>)

    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText(/<script>/u)).toBeDefined()
  })

  it('renders GFM structure instead of exposing its punctuation', () => {
    render(<MessageMarkdown>{'**Ready**\n\n- one\n- two\n\n`pnpm check`'}</MessageMarkdown>)

    expect(screen.getByText('Ready').tagName).toBe('STRONG')
    expect(screen.getByRole('list').children).toHaveLength(2)
    expect(screen.getByText('pnpm check').tagName).toBe('CODE')
  })
})
