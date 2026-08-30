/**
 * The conversation surface: transcript, live activity, composer, and durable work projection.
 *
 * Loading the conversation stays in chat.tsx. This module owns how one loaded answer is shown and
 * interacted with, so its scrolling and composer remain one geometry instead of two page states.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'react-bootstrap-icons'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScroller,
} from '../../components/ui/message-scroller.tsx'
import { ChatActivity } from './chat-activity.tsx'
import { ChatMessage, ChatMessageText } from './chat-message.tsx'
import { ToolRun, type ToolMessage } from './chat-tools.tsx'
import { ConversationComposer, type PendingUserMessage } from './conversation-composer.tsx'
import { HandoverControl, HandoverProposal } from './conversation-work.tsx'
import {
  type useConversation,
  useWatching,
  type LiveOutput,
  type LiveTurn,
  type Message,
} from './talking.ts'
import {
  getLatestUserPrompt,
  promptToPin,
  type LatestUserPrompt,
  type TranscriptRow,
} from './transcript-scroll.ts'
import { WorkPanel } from './work-panel.tsx'

export const CHAT_SCROLL_EDGE_PX = 48
const PROMPT_TOP_GAP_PX = 24

export type ChatAgent = { readonly avatarSrc: string; readonly name: string }

type ConversationSurfaceProps = {
  readonly slug: string
  readonly id: string
  readonly conversation: NonNullable<ReturnType<typeof useConversation>['data']>
  readonly agent: ChatAgent
  readonly ownUserId: string | undefined
  readonly title: string
  readonly animateArrival: boolean
}

export function ConversationSurface({
  slug,
  id,
  conversation,
  agent,
  ownUserId,
  title,
  animateArrival,
}: ConversationSurfaceProps) {
  const { messages, working, underway } = conversation
  const [pendingMessage, setPendingMessage] = useState<PendingUserMessage>()
  const [mobileWorkOpen, setMobileWorkOpen] = useState(false)
  const currentTurn = turnOf(messages)
  const turns = useMemo(() => transcriptTurns(messages), [messages])
  const rows = useMemo(() => rowsWithPending(turns, pendingMessage), [pendingMessage, turns])
  const watching = useWatching(slug, id, currentTurn, ownUserId)
  const { scrollToEnd, scrollToMessage } = useMessageScroller()
  const latestPrompt = useRef<LatestUserPrompt | null>(null)
  const positionedConversation = useRef<string | null>(null)

  useLayoutEffect(() => {
    const nextPrompt = getLatestUserPrompt(rows)
    if (positionedConversation.current !== id) {
      positionedConversation.current = id
      latestPrompt.current = nextPrompt
      if (animateArrival && nextPrompt !== null) {
        scrollToMessage(nextPrompt.rowId, {
          align: 'start',
          scrollMargin: PROMPT_TOP_GAP_PX,
        })
      } else {
        scrollToEnd()
      }
      return
    }

    const previousPrompt = latestPrompt.current
    latestPrompt.current = nextPrompt
    const prompt = promptToPin(previousPrompt, nextPrompt)
    if (prompt === null) return
    scrollToMessage(prompt.rowId, {
      align: 'start',
      scrollMargin: PROMPT_TOP_GAP_PX,
    })
  }, [animateArrival, id, rows, scrollToEnd, scrollToMessage])

  return (
    <section className="chat-screen" aria-label="Chat">
      <header className="chat-conversation-header gap-2">
        <strong>{title}</strong>
        <HandoverControl
          slug={slug}
          id={id}
          underway={underway}
          working={working.state === 'working'}
        />
        {underway !== undefined && (
          <button
            className="ml-auto h-7 rounded-[6px] border border-panel-line-firm px-2.5 text-[12px] font-medium text-panel-ink-soft lg:hidden"
            type="button"
            onClick={() => {
              setMobileWorkOpen(true)
            }}
          >
            Work details
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <ConversationMain
          slug={slug}
          id={id}
          conversation={conversation}
          agent={agent}
          turns={turns}
          currentTurn={currentTurn}
          animateArrival={animateArrival}
          watching={watching}
          pendingMessage={pendingMessage}
          setPendingMessage={setPendingMessage}
        />
        {underway !== undefined && (
          <aside
            className="hidden h-full w-[320px] shrink-0 border-l border-panel-line lg:block"
            aria-label="Work details"
          >
            <WorkPanel slug={slug} id={id} underway={underway} />
          </aside>
        )}
        {underway !== undefined && mobileWorkOpen && (
          <div className="absolute inset-x-0 top-11 bottom-0 z-30 bg-white lg:hidden">
            <WorkPanel
              slug={slug}
              id={id}
              underway={underway}
              close={() => {
                setMobileWorkOpen(false)
              }}
            />
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * How far the reader has scrolled from the live edge, and the one thing that depends on it.
 *
 * Kept beside the viewport it measures rather than in the screen above: nothing up there reads
 * it, and it was four props — a ref, the measuring, the answer, and a way back to the edge — for
 * one question.
 */
function useDistanceFromLatest() {
  const viewport = useRef<HTMLDivElement>(null)
  const [hasScrolledAway, setHasScrolledAway] = useState(false)

  const noteScrollPosition = (): void => {
    const element = viewport.current
    if (element === null) return

    const distance = element.scrollHeight - element.clientHeight - element.scrollTop
    setHasScrolledAway(distance > CHAT_SCROLL_EDGE_PX)
  }

  return { viewport, hasScrolledAway, noteScrollPosition }
}

function ConversationMain({
  slug,
  id,
  conversation,
  agent,
  turns,
  currentTurn,
  animateArrival,
  watching,
  pendingMessage,
  setPendingMessage,
}: {
  readonly slug: string
  readonly id: string
  readonly conversation: ConversationSurfaceProps['conversation']
  readonly agent: ChatAgent
  readonly turns: readonly TranscriptTurn[]
  readonly currentTurn: number
  readonly animateArrival: boolean
  readonly watching: ReturnType<typeof useWatching>
  readonly pendingMessage: PendingUserMessage | undefined
  readonly setPendingMessage: (message: PendingUserMessage | undefined) => void
}) {
  const { agentKind, messages, offers, working, underway } = conversation
  const { scrollToEnd } = useMessageScroller()
  const { viewport, hasScrolledAway, noteScrollPosition } = useDistanceFromLatest()

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <MessageScroller className="chat-scroll-root">
        <MessageScrollerViewport
          ref={viewport}
          className="chat-scroll"
          onScroll={noteScrollPosition}
        >
          <MessageScrollerContent className="chat-scroll-content">
            <Transcript
              slug={slug}
              id={id}
              underway={underway}
              messages={messages}
              turns={turns}
              turn={currentTurn}
              agent={agent}
              animateArrival={animateArrival}
              working={working.state === 'working'}
              liveTurn={watching.liveTurn}
              pendingMessage={pendingMessage}
            />
            {working.state === 'unknown' && (
              <div className="chat-transcript-footer">
                <p className="chat-working">Nobody knows how that turn ended.</p>
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <ScrollToLatest
          show={hasScrolledAway}
          onClick={() => {
            scrollToEnd({ behavior: 'smooth' })
          }}
        />
      </MessageScroller>
      <div className="chat-input-dock">
        <div className="chat-input-wash" aria-hidden />
        <div className="chat-input-surface">
          <ConversationComposer
            slug={slug}
            id={id}
            offers={offers}
            agentKind={agentKind}
            agentName={agent.name}
            avatarSrc={agent.avatarSrc}
            working={working.state === 'working'}
            turn={currentTurn}
            afterSeq={messages.at(-1)?.seq ?? 0}
            onPending={(message) => {
              if (message !== undefined) watching.startTurn(message.seq)
              setPendingMessage(message)
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** The jump back to the live edge, offered only when the reader has left it. */
function ScrollToLatest({
  show,
  onClick,
}: {
  readonly show: boolean
  readonly onClick: () => void
}) {
  return (
    <div className="chat-scroll-to-bottom" data-visible={show || undefined}>
      <button type="button" aria-label="Scroll to latest message" onClick={onClick}>
        <ArrowDown aria-hidden />
      </button>
    </div>
  )
}

type AssistantMessage = Extract<Message, { readonly role: 'assistant' }>
type ActivityMessage = Extract<Message, { readonly role: 'activity' }>
type ReplyBlock =
  | { readonly kind: 'assistant'; readonly message: AssistantMessage }
  | { readonly kind: 'tools'; readonly messages: ToolMessage[] }
  | { readonly kind: 'activity'; readonly message: ActivityMessage; readonly text: string }

function replyBlocks(messages: readonly Message[]): ReplyBlock[] {
  const blocks: ReplyBlock[] = []
  for (const message of messages) addReplyBlock(blocks, message)
  return blocks
}

function addReplyBlock(blocks: ReplyBlock[], message: Message): void {
  if (message.role === 'assistant') {
    blocks.push({ kind: 'assistant', message })
    return
  }
  if (message.role === 'activity') {
    const text = activityText(message)
    if (text !== null) blocks.push({ kind: 'activity', message, text })
    return
  }
  if (message.role !== 'tool') return

  const previous = blocks.at(-1)
  if (previous?.kind === 'tools') previous.messages.push(message)
  else blocks.push({ kind: 'tools', messages: [message] })
}

type TranscriptTurn =
  | { readonly key: string; readonly user: Extract<Message, { readonly role: 'user' }> }
  | { readonly key: string; readonly reply: Message[] }

function transcriptTurns(messages: readonly Message[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const message of messages) addTranscriptTurn(turns, message)
  return turns
}

function rowsWithPending(
  turns: readonly TranscriptTurn[],
  pending: PendingUserMessage | undefined,
): readonly TranscriptRow[] {
  const rows = turns.map(transcriptRow)
  if (pending === undefined) return rows
  return [...rows, { id: 'pending-user', kind: 'user', seq: pending.seq }]
}

function transcriptRow(turn: TranscriptTurn): TranscriptRow {
  if ('user' in turn) {
    return { id: turn.key, kind: 'user', seq: turn.user.seq }
  }
  return { id: turn.key, kind: 'reply', seq: turn.reply[0]?.seq ?? 0 }
}

function Transcript({
  slug,
  id,
  underway,
  messages,
  turns,
  turn,
  agent,
  animateArrival,
  working,
  liveTurn,
  pendingMessage,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: ConversationSurfaceProps['conversation']['underway']
  readonly messages: readonly Message[]
  readonly turns: readonly TranscriptTurn[]
  readonly turn: number
  readonly agent: ChatAgent
  readonly animateArrival: boolean
  readonly working: boolean
  readonly liveTurn: LiveTurn
  readonly pendingMessage: PendingUserMessage | undefined
}) {
  const [firstPaintEndsAt] = useState(() => messages.at(-1)?.seq)
  const activeCallId = liveTurn.activity?.said === 'doing' ? liveTurn.activity.callId : undefined
  const activeCallIsWritten =
    activeCallId !== undefined &&
    messages.some((message) => message.role === 'tool' && message.content.callId === activeCallId)
  const activeOutput = activeCallId === undefined ? undefined : liveTurn.outputs.get(activeCallId)

  return (
    <>
      {turns.map((turn) => {
        const row = transcriptRow(turn)
        return (
          <MessageScrollerItem key={turn.key} messageId={row.id}>
            <div className="chat-transcript-row" data-transcript-row-id={row.id}>
              {'user' in turn ? (
                <ChatMessage placement="right" at={turn.user.at} copyText={turn.user.content.text}>
                  <ChatMessageText
                    message={turn.user}
                    animate={
                      turn.user.seq > (firstPaintEndsAt ?? 0) ||
                      (animateArrival && turn.user.seq === firstPaintEndsAt)
                    }
                  />
                </ChatMessage>
              ) : (
                <AgentReply
                  slug={slug}
                  id={id}
                  underway={underway}
                  messages={turn.reply}
                  agent={agent}
                  liveOutputs={liveTurn.outputs}
                />
              )}
            </div>
          </MessageScrollerItem>
        )
      })}
      {pendingMessage !== undefined && (
        <MessageScrollerItem messageId="pending-user">
          <div className="chat-transcript-row" data-transcript-row-id="pending-user">
            <ChatMessage
              placement="right"
              at={pendingMessage.at}
              copyText={pendingMessage.content.text}
            >
              <ChatMessageText message={pendingMessage} animate />
            </ChatMessage>
          </div>
        </MessageScrollerItem>
      )}
      {liveTurn.typing.length > 0 && (
        <MessageScrollerItem messageId="typing">
          <div className="chat-transcript-row">
            <p className="chat-typing" role="status" aria-live="polite">
              {typingText(liveTurn.typing)}
            </p>
          </div>
        </MessageScrollerItem>
      )}
      {working && !activeCallIsWritten && (
        <MessageScrollerItem messageId={`live-${String(turn)}`}>
          <div className="chat-transcript-row chat-live-row">
            <ChatActivity activity={liveTurn.activity} output={activeOutput} />
          </div>
        </MessageScrollerItem>
      )}
    </>
  )
}

function addTranscriptTurn(turns: TranscriptTurn[], message: Message) {
  if (message.role === 'user') {
    turns.push({ key: `user-${String(message.seq)}`, user: message })
    return
  }

  const previous = turns.at(-1)
  if (previous !== undefined && 'reply' in previous) previous.reply.push(message)
  else turns.push({ key: `reply-${String(message.seq)}`, reply: [message] })
}

function AgentReply({
  slug,
  id,
  underway,
  messages,
  agent,
  liveOutputs,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: ConversationSurfaceProps['conversation']['underway']
  readonly messages: readonly Message[]
  readonly agent: ChatAgent
  readonly liveOutputs: ReadonlyMap<string, LiveOutput>
}) {
  const blocks = replyBlocks(messages)
  const first = blocks[0]
  if (first === undefined) return null
  const beganAt = blockStartedAt(first)
  if (beganAt === undefined) return null
  const copyText = blocks
    .flatMap((block) => (block.kind === 'assistant' ? [block.message.content.text] : []))
    .join('\n\n')

  return (
    <ChatMessage
      placement="left"
      at={beganAt}
      avatarSrc={agent.avatarSrc}
      author={agent.name}
      copyText={copyText}
    >
      <div className="chat-agent-reply">
        <ReplyContent
          slug={slug}
          id={id}
          underway={underway}
          blocks={blocks}
          liveOutputs={liveOutputs}
        />
      </div>
    </ChatMessage>
  )
}

function blockStartedAt(block: ReplyBlock): string | undefined {
  if (block.kind === 'assistant') return block.message.at
  if (block.kind === 'activity') return block.message.at
  return block.messages[0]?.at
}

function ReplyContent({
  slug,
  id,
  underway,
  blocks,
  liveOutputs,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: ConversationSurfaceProps['conversation']['underway']
  readonly blocks: readonly ReplyBlock[]
  readonly liveOutputs: ReadonlyMap<string, LiveOutput>
}) {
  return (
    <div className="chat-agent-reply-content">
      {blocks.map((block) => {
        if (block.kind === 'tools') {
          return (
            <ToolRun
              key={`tools-${String(block.messages[0]?.seq ?? 0)}`}
              messages={block.messages}
              liveOutputs={liveOutputs}
            />
          )
        }
        if (block.kind === 'activity') {
          if (block.message.content.activityType === 'proposed') {
            return (
              <HandoverProposal
                key={`activity-${String(block.message.seq)}`}
                slug={slug}
                id={id}
                goal={block.text}
                active={underway?.goal === block.text}
                available={underway === undefined}
              />
            )
          }
          return (
            <p className="chat-line-activity" key={`activity-${String(block.message.seq)}`}>
              {block.text}
            </p>
          )
        }
        return (
          <ChatMessageText key={`answer-${String(block.message.seq)}`} message={block.message} />
        )
      })}
    </div>
  )
}

function typingText(people: LiveTurn['typing']): string {
  const names = people.map((person) => person.name)
  if (names.length === 1) return `${names[0]} is typing…`
  return `${names.join(', ')} are typing…`
}

function turnOf(messages: readonly Message[]): number {
  let latest = 0
  for (const message of messages) {
    if (message.role === 'user') latest = message.seq
  }
  return latest
}

/** Words for durable activity lines that do not carry their own text. */
const ACTIVITY_TEXT = new Map<string, string>([
  ['cancelled', 'Stopped'],
  ['failed', 'That turn failed'],
  ['unknown', 'Nobody knows how that turn ended'],
  ['forgot', 'This agent could not remember the earlier chat'],
  ['started-over', 'The folder this was working in had been deleted, so it started over'],
  ['stop', 'You asked it to stop'],
  ['unreadable', 'One event could not be read'],
])

function activityText(what: Extract<Message, { readonly role: 'activity' }>): string | null {
  if (what.content.activityType === 'done') return null
  const said: unknown = what.content['text']
  if (typeof said === 'string' && said !== '') return said

  return ACTIVITY_TEXT.get(what.content.activityType) ?? what.content.activityType
}
