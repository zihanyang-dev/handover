/**
 * That watching a turn does not cost more the longer you have been talking.
 *
 * What streams is a command's output, three kilobytes at a time, and each piece is one React
 * update. Nothing about a piece has anything to do with what was said an hour ago — but the live
 * state was threaded through the transcript, so every finished message re-rendered on every
 * piece, and every one of them ran remark over its text again. The cost of one piece of output
 * was proportional to the whole conversation, so a long one melted the tab.
 *
 * Counted rather than timed. A duration here would be about this machine; the number of times
 * markdown is parsed is the thing that was wrong, and it is the same number everywhere.
 *
 * Everybody who builds one of these arrives here: Vercel's AI SDK cookbook memoizes markdown
 * while streaming, Streamdown exists to, and LibreChat's `#13576` is this exact symptom.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageScrollerProvider } from '../../components/ui/message-scroller.tsx'
import { serverSends } from '../../pretend/event-source.ts'
import { ConversationSurface } from './conversation-surface.tsx'

/** How many times remark has been asked to parse anything at all, this test. */
const parsed = { times: 0 }

// The real one is the expensive thing under test; counting it is the measurement. Its output does
// not matter here — what matters is how often it is asked.
vi.mock('react-markdown', () => ({
  default: ({ children }: { readonly children: string }) => {
    parsed.times += 1
    return <span>{children}</span>
  },
}))

const SLUG = 'acme'
const ID = '11111111-1111-4111-8111-111111111111'
const LIVE = `/spaces/${SLUG}/conversations/${ID}/live`

/** A conversation somebody has been in for a while: many finished replies, nothing running. */
function transcriptOf(replies: number) {
  return [...Array.from({ length: replies }).keys()].flatMap((at) => [
    {
      seq: at * 2 + 1,
      at: new Date().toISOString(),
      role: 'user' as const,
      said: null,
      content: { text: `ask number ${String(at)}` },
    },
    {
      seq: at * 2 + 2,
      at: new Date().toISOString(),
      role: 'assistant' as const,
      content: { text: `answer number ${String(at)} with **some** markdown in it` },
    },
  ])
}

function show(replies: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const conversation = {
    id: ID,
    agentKind: 'claude-code',
    machineId: '22222222-2222-4222-8222-222222222222',
    working: { state: 'working' as const },
    offers: [],
    messages: transcriptOf(replies),
  }

  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MessageScrollerProvider>{children}</MessageScrollerProvider>
    </QueryClientProvider>
  )

  return render(
    <ConversationSurface
      slug={SLUG}
      id={ID}
      conversation={conversation as never}
      agent={{ avatarSrc: '', name: 'Claude Code' }}
      ownUserId="33333333-3333-4333-8333-333333333333"
      title="a long conversation"
      animateArrival={false}
    />,
    { wrapper },
  )
}

/** One three-kilobyte piece of a command's output, the way a machine sends it. */
function onePieceOfOutput(at: number) {
  serverSends(LIVE, {
    seen: 'moment',
    moment: { said: 'output', callId: 'call-1', at, text: 'x'.repeat(3000) },
  })
}

beforeEach(() => {
  parsed.times = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('what one piece of streamed output costs', () => {
  it('does not re-parse a single finished message', () => {
    show(40)
    const afterFirstPaint = parsed.times
    expect(afterFirstPaint).toBeGreaterThan(40)

    act(() => {
      onePieceOfOutput(0)
    })

    // Not "fewer than before" — none. A finished message has nothing to do with what a command is
    // printing now, so the honest number is zero and anything above it is work that grows with
    // the length of the conversation.
    expect(parsed.times - afterFirstPaint).toBe(0)
  })

  it('costs the same on a long conversation as on a short one', () => {
    const { unmount } = show(4)
    const short = parsed.times
    act(() => {
      onePieceOfOutput(0)
    })
    const shortPiece = parsed.times - short
    unmount()

    parsed.times = 0
    show(120)
    const long = parsed.times
    act(() => {
      onePieceOfOutput(0)
    })

    // Thirty times the conversation, and a piece of output costs the same. This is the shape of
    // the bug rather than its size: before, these two numbers were 4 and 120.
    expect(parsed.times - long).toBe(shortPiece)
  })
})
