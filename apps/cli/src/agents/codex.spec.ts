import { describe, expect, it } from 'vitest'
import type { AppNotification } from './codex-app-server.ts'
import { toldFromNotification } from './codex.ts'

const TURN = { threadId: 'thread-1', turnId: 'turn-1' }

function notification(method: string, params: Record<string, unknown>): AppNotification {
  return { method, params: { ...TURN, ...params } }
}

describe('Codex app-server events', () => {
  it('streams command output at the real offsets and keeps only its excerpt', () => {
    const outputs = new Map<string, string>()
    const started = toldFromNotification(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'command-1',
          command: 'printf lines',
          status: 'inProgress',
        },
      }),
      TURN,
      outputs,
    )
    const first = toldFromNotification(
      notification('item/commandExecution/outputDelta', {
        itemId: 'command-1',
        delta: 'first\n',
      }),
      TURN,
      outputs,
    )
    const second = toldFromNotification(
      notification('item/commandExecution/outputDelta', {
        itemId: 'command-1',
        delta: 'second\n',
      }),
      TURN,
      outputs,
    )
    const completed = toldFromNotification(
      notification('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'command-1',
          command: 'printf lines',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'first\nsecond\n',
        },
      }),
      TURN,
      outputs,
    )

    expect(started).toEqual([
      {
        told: 'said',
        said: {
          said: 'doing',
          callId: 'command-1',
          name: 'command_execution',
          verb: 'ran',
          arg: 'printf lines',
        },
      },
    ])
    expect(first).toEqual([
      { told: 'said', said: { said: 'output', callId: 'command-1', at: 0, text: 'first\n' } },
    ])
    expect(second).toEqual([
      { told: 'said', said: { said: 'output', callId: 'command-1', at: 6, text: 'second\n' } },
    ])
    expect(completed).toEqual([
      {
        told: 'said',
        said: {
          said: 'did',
          callId: 'command-1',
          name: 'command_execution',
          verb: 'ran',
          arg: 'printf lines',
          ok: true,
          excerpt: 'first\nsecond\n',
        },
      },
    ])
    expect(outputs.has('command-1')).toBe(false)
  })

  it('keeps interleaved command output under its own call id', () => {
    const outputs = new Map<string, string>()

    toldFromNotification(
      notification('item/commandExecution/outputDelta', { itemId: 'one', delta: 'a' }),
      TURN,
      outputs,
    )
    const two = toldFromNotification(
      notification('item/commandExecution/outputDelta', { itemId: 'two', delta: 'b' }),
      TURN,
      outputs,
    )
    const one = toldFromNotification(
      notification('item/commandExecution/outputDelta', { itemId: 'one', delta: 'c' }),
      TURN,
      outputs,
    )

    expect(two[0]).toMatchObject({ said: { callId: 'two', at: 0, text: 'b' } })
    expect(one[0]).toMatchObject({ said: { callId: 'one', at: 1, text: 'c' } })
    expect(outputs).toEqual(
      new Map([
        ['one', 'ac'],
        ['two', 'b'],
      ]),
    )
  })

  it('preserves assistant blocks around a tool in source order', () => {
    const outputs = new Map<string, string>()
    const before = toldFromNotification(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'message-1', text: 'Before the tool' },
      }),
      TURN,
      outputs,
    )
    const tool = toldFromNotification(
      notification('item/completed', {
        item: { type: 'webSearch', id: 'search-1', query: 'Handover' },
      }),
      TURN,
      outputs,
    )
    const after = toldFromNotification(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'message-2', text: 'After the tool' },
      }),
      TURN,
      outputs,
    )

    expect([...before, ...tool, ...after]).toMatchObject([
      { said: { said: 'text', text: 'Before the tool' } },
      { said: { said: 'did', callId: 'search-1' } },
      { said: { said: 'text', text: 'After the tool' } },
    ])
  })

  it('keeps the name of a tool this build does not know', () => {
    const told = toldFromNotification(
      notification('item/completed', { item: { type: 'laterTool', id: 'later-1' } }),
      TURN,
      new Map(),
    )

    expect(told).toEqual([
      {
        told: 'said',
        said: { said: 'did', callId: 'later-1', name: 'laterTool', verb: '', arg: '', excerpt: '' },
      },
    ])
  })

  it('does not promote notifications from a nested or unrelated thread', () => {
    const told = toldFromNotification(
      {
        method: 'item/completed',
        params: {
          threadId: 'subagent-thread',
          turnId: 'subagent-turn',
          item: { type: 'agentMessage', id: 'internal', text: 'Internal prompt' },
        },
      },
      TURN,
      new Map(),
    )

    expect(told).toEqual([])
  })

  it.each([
    ['completed', { why: 'done' }],
    ['interrupted', { why: 'cancelled' }],
    ['failed', { why: 'failed', said: 'boom' }],
  ])('maps a %s turn to one ending', (status, why) => {
    const told = toldFromNotification(
      {
        method: 'turn/completed',
        params: {
          threadId: TURN.threadId,
          turn: {
            id: TURN.turnId,
            status,
            error: status === 'failed' ? { message: 'boom' } : null,
          },
        },
      },
      TURN,
      new Map(),
    )

    expect(told).toEqual([{ told: 'ended', why }])
  })
})
