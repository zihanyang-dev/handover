import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatActivity } from './chat-activity.tsx'

afterEach(cleanup)

describe('live agent work', () => {
  it('starts with an elapsed working state before any detail arrives', () => {
    render(<ChatActivity activity={undefined} output={undefined} />)

    expect(screen.getByRole('status').textContent).toBe('Working…Working…')
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

    expect(screen.getByRole('status').textContent).toContain('Run pnpm test')
    expect(screen.getByLabelText('Live tool output').textContent).toBe('first\nsecond\n')
  })

  it('shows only the latest unresolved activity', () => {
    render(
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

    expect(screen.getAllByText('Read apps/web/style.css')).toHaveLength(2)
    expect(screen.queryByText('Reading the current composer')).toBeNull()
    expect(screen.getByLabelText('Live tool output').textContent).toBe('TypeScript clean')
  })
})
