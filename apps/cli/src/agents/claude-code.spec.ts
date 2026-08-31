import { describe, expect, it } from 'vitest'
import { fold, toldFrom } from './claude-code.ts'

/** One of Claude's messages, as the SDK hands it over: a list of blocks and nothing else read. */
const message = (...content: readonly Record<string, unknown>[]) => ({ content })

describe('turning what Claude says into what a page shows', () => {
  it('keeps the name of a tool it has never heard of', async () => {
    // The set of tools is open — one MCP server adds as many as it likes — so a page that could
    // only show tools from a list would go blind the first time somebody connected one. No verb
    // is the honest answer here: nobody can say in a word what a tool we do not know just did.
    const translate = fold()

    const doing = translate(
      message({ type: 'tool_use', id: 't1', name: 'mcp__notion__search', input: { query: 'q' } }),
    )

    expect(doing).toEqual([
      { said: 'doing', callId: 't1', name: 'mcp__notion__search', verb: '', arg: '' },
    ])
  })

  it('says in a word what a tool it does know just did', async () => {
    const translate = fold()

    expect(
      translate(message({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -a' } })),
    ).toEqual([{ said: 'doing', callId: 't1', name: 'Bash', verb: 'ran', arg: 'ls -a' }])
  })

  it('keeps what a tool was given down to an excerpt, however long it was', () => {
    // A `Bash` argument is whatever somebody's agent typed, and a heredoc writing a file carries
    // that whole file in it. Kept whole, the transcript stops being a record of what happened and
    // becomes the place a copy of the file lives — in Postgres, for ever, one row per turn.
    const file = 'x'.repeat(5000)
    const translate = fold()
    const [told] = translate(
      message({
        type: 'tool_use',
        id: 'one',
        name: 'Bash',
        input: { command: `cat > big.txt <<'EOF'\n${file}\nEOF` },
      }),
    )

    expect(told).toBeDefined()
    expect(String(JSON.stringify(told)).length).toBeLessThan(1000)
  })

  it('waits for the result before writing the line down', async () => {
    // A call and its result arrive as two blocks in two messages. The row for a tool is written
    // once, when there is something to say about how it went — a line written at the call would
    // have to be revised, and a transcript is never revised.
    const translate = fold()
    translate(
      message({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } }),
    )

    const did = translate(
      message({ type: 'tool_result', tool_use_id: 't1', content: 'the first line' }),
      'user',
    )

    expect(did).toEqual([
      {
        said: 'did',
        callId: 't1',
        name: 'Read',
        verb: 'read',
        arg: 'b.ts',
        ok: true,
        excerpt: 'the first line',
        // The whole of it travels beside the excerpt, for whoever is watching. Short enough here
        // that the two are the same words; `answering.ts` is what decides not to send it twice.
        output: 'the first line',
      },
    ])
  })

  it('says a tool failed, since that is half of what a person is watching for', async () => {
    const translate = fold()
    translate(message({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }))

    const [did] = translate(
      message({ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit 1' }),
      'user',
    )

    expect(did).toMatchObject({ said: 'did', ok: false, excerpt: 'exit 1' })
  })

  it('ignores a result for a call it never saw begin', async () => {
    // A turn picked up part way through — a page that reconnected, a replay — starts reading in
    // the middle. A line about a call nobody watched start has no verb, no argument and nothing
    // to pair with, and inventing one would put a tool call in the transcript that never happened
    // here.
    const translate = fold()

    expect(
      translate(message({ type: 'tool_result', tool_use_id: 'gone', content: 'x' }), 'user'),
    ).toEqual([])
  })

  it('does not promote nested agent traffic into the top-level transcript', () => {
    const translate = fold()
    const sdk = (value: unknown) => value as Parameters<typeof toldFrom>[0]

    toldFrom(
      sdk({
        type: 'assistant',
        parent_tool_use_id: null,
        message: message({ type: 'tool_use', id: 'agent-1', name: 'Agent', input: {} }),
      }),
      translate,
    )

    expect(
      toldFrom(
        sdk({
          type: 'assistant',
          parent_tool_use_id: 'agent-1',
          message: message({ type: 'text', text: 'Internal subagent answer' }),
        }),
        translate,
      ),
    ).toEqual([])
    expect(
      toldFrom(
        sdk({
          type: 'user',
          parent_tool_use_id: 'agent-1',
          message: message({ type: 'tool_result', tool_use_id: 'nested', content: 'internal' }),
        }),
        translate,
      ),
    ).toEqual([])
    expect(
      toldFrom(
        sdk({
          type: 'user',
          parent_tool_use_id: null,
          message: message({
            type: 'tool_result',
            tool_use_id: 'agent-1',
            content: 'final report',
          }),
        }),
        translate,
      ),
    ).toMatchObject([{ told: 'said', said: { said: 'did', callId: 'agent-1' } }])
  })

  it('carries thinking through as thinking, for the live stream to show and drop', async () => {
    const translate = fold()

    expect(translate(message({ type: 'thinking', thinking: 'let me look' }))).toEqual([
      { said: 'thinking', text: 'let me look' },
    ])
  })

  it('says nothing about a block it does not understand', async () => {
    const translate = fold()

    expect(translate(message({ type: 'something-new-in-a-later-cli' }))).toEqual([])
  })
})

describe('a plan rather than a tool call', () => {
  const writing = (...todos: readonly (readonly [string, string])[]) =>
    message({
      type: 'tool_use',
      id: 'plan-1',
      name: 'TodoWrite',
      input: {
        todos: todos.map(([content, status]) => ({ content, status, activeForm: content })),
      },
    })

  it('says what the steps are, not how many there were', () => {
    // The line this replaces said "planned 7 steps" and nothing else. What somebody watching
    // needs is the seven.
    const translate = fold()

    expect(
      translate(writing(['read the code', 'completed'], ['write the test', 'in_progress'])),
    ).toEqual([
      {
        said: 'planned',
        steps: [
          { text: 'read the code', state: 'done' },
          { text: 'write the test', state: 'doing' },
        ],
      },
    ])
  })

  it('says nothing at all when the list is misshapen', () => {
    // Half a plan is worse than none: nothing on the page would say the rest was dropped.
    const translate = fold()

    expect(translate(writing(['read the code', 'whenever'] as never))).toEqual([])
  })

  it('does not write the plan down twice when its result comes back', () => {
    // A plan's result is the plan read back. Left alone it would be a tool row saying a list was
    // written, next to the list.
    const translate = fold()
    translate(writing(['read the code', 'pending']))

    expect(
      translate(message({ type: 'tool_result', tool_use_id: 'plan-1', content: 'ok' }), 'user'),
    ).toEqual([])
  })
})
