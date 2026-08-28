import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatActivity } from './chat-activity.tsx'

afterEach(cleanup)

describe('live agent work', () => {
  it('starts with a working state before any detail arrives', () => {
    render(<ChatActivity activity={undefined} output={undefined} />)

    expect(screen.getByRole('status', { name: 'Working…' })).toBeDefined()
  })

  it('shows live tool output as its ordered pieces arrive', () => {
    render(
      <ChatActivity
        activity={{
          said: 'doing',
          callId: 'command-1',
          name: 'Bash',
          verb: 'Run',
          arg: 'pnpm test',
        }}
        output={{ text: 'first\nsecond\n', from: 0, truncated: false }}
      />,
    )

    expect(screen.getByRole('status', { name: 'Run pnpm test' })).toBeDefined()
    expect(screen.getByLabelText('Live tool output').textContent).toBe('first\nsecond\n')
  })

  it('replaces an earlier activity instead of leaving a second owner', () => {
    const view = render(
      <ChatActivity
        activity={{ said: 'thinking', text: 'Reading the current composer' }}
        output={undefined}
      />,
    )

    view.rerender(
      <ChatActivity
        activity={{
          said: 'doing',
          callId: 'read-1',
          name: 'Read',
          verb: 'Read',
          arg: 'apps/web/style.css',
        }}
        output={{ text: 'TypeScript clean', from: 0, truncated: false }}
      />,
    )

    expect(screen.getByRole('status', { name: 'Read apps/web/style.css' })).toBeDefined()
    expect(screen.queryByText('Reading the current composer')).toBeNull()
    expect(screen.getByLabelText('Live tool output').textContent).toBe('TypeScript clean')
  })
})
