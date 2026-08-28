import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolRun, type ToolMessage } from './chat-tools.tsx'

afterEach(cleanup)

function tool(name: string, excerpt: string): ToolMessage {
  return {
    role: 'tool',
    seq: 1,
    at: '2026-08-28T12:00:00.000Z',
    content: { name, verb: 'ran', arg: 'command', excerpt },
  }
}

describe('chat tool rows', () => {
  it('does not turn command output that starts with signs into a file diff', async () => {
    render(
      <ToolRun
        messages={[tool('command_execution', '- help\n+ verbose')]}
        liveOutputs={new Map()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /ran 1 step/iu }))
    expect(screen.queryByRole('button', { name: /show diff/iu })).toBeNull()
  })

  it('shows normalized file changes as a diff', async () => {
    render(<ToolRun messages={[tool('file_change', '- old\n+ new')]} liveOutputs={new Map()} />)

    await userEvent.click(screen.getByRole('button', { name: /ran 1 step/iu }))
    expect(screen.getByRole('button', { name: /show diff for command/iu })).toBeDefined()
  })
})
