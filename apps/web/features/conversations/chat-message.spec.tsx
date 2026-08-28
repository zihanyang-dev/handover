import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMessage } from './chat-message.tsx'

afterEach(cleanup)

describe('chat message', () => {
  it('keeps the agent identity, timestamp, body, and action in one left message row', () => {
    render(
      <ChatMessage
        placement="left"
        at="2026-08-28T12:00:00.000Z"
        avatarSrc="/sam.png"
        agentName="sam"
        copyText="Ready"
      >
        <p>Ready</p>
      </ChatMessage>,
    )

    expect(screen.getByRole('article').getAttribute('data-placement')).toBe('left')
    expect(screen.getByText('sam').textContent).toBe('sam')
    expect(document.querySelector('.chat-message-avatar img')).not.toBeNull()
    expect(screen.getByText('Ready').textContent).toBe('Ready')
    expect(screen.getByRole('menuitem', { name: 'Copy message' }).tagName).toBe('BUTTON')
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-08-28T12:00:00.000Z',
    )
  })

  it('copies without adding a native tooltip', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <ChatMessage placement="right" at="2026-08-28T12:00:00.000Z" copyText="Hello">
        <p>Hello</p>
      </ChatMessage>,
    )

    const copy = screen.getByRole('menuitem', { name: 'Copy message' })
    expect(copy.hasAttribute('title')).toBe(false)
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledWith('Hello')
    expect(screen.getByRole('menuitem', { name: 'Copied' }).tagName).toBe('BUTTON')
  })
})
