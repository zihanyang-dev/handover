/**
 * One conversation, read and spoken into.
 *
 * Two things are on screen at once and only one of them survives: the transcript, which is
 * everything that was written down, and the live line under it, which is what is happening this
 * moment and is kept nowhere. They come from different places on purpose — see `talking.ts`.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'react-bootstrap-icons'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '../../components/ui/message-scroller.tsx'
import { meQuery } from '../identity/me.ts'
import { agentKindName } from '../machines/agent.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import { ChatActivity } from './chat-activity.tsx'
import { ChatMessage, ChatMessageText } from './chat-message.tsx'
import { ToolRun, type ToolMessage } from './chat-tools.tsx'
import { ConversationComposer, type PendingUserMessage } from './conversation-composer.tsx'
import { consumeMessageArrival } from './message-transition.ts'
import {
  conversationsIn,
  useConversation,
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

const AT_END_THRESHOLD_PX = 48
const PROMPT_TOP_GAP_PX = 24

type ChatAgent = { readonly avatarSrc: string; readonly name: string }

export function Chat({ slug, id }: { readonly slug: string; readonly id: string }) {
  const conversation = useConversation(slug, id)
  const conversationTitle = useQuery({
    ...conversationsIn(slug),
    select: (answer) => answer.conversations.find((one) => one.id === id)?.opening,
  })
  const machines = useQuery(machinesIn(slug))
  const me = useQuery(meQuery)
  const [animateArrival] = useState(() => consumeMessageArrival(id))

  if (conversation.isPending) return <p className="chat-screen-state">Looking…</p>
  if (conversation.isError)
    return <p className="chat-screen-state">Could not read this chat. Try again.</p>
  if (conversation.data === null) {
    return (
      <div className="chat-screen-state">
        <p>This chat is not available.</p>
        <Link to="/s/$slug" params={{ slug }}>
          Back to the Space
        </Link>
      </div>
    )
  }

  const { agentKind, machineName } = conversation.data
  const installed = agentsOn(machines.data ?? []).find(
    (agent) => agent.kind === agentKind && agent.machineName === machineName,
  )
  const agent = agentPresentation(installed, agentKind)
  const title =
    conversationTitle.data ??
    conversation.data.messages.find((message) => message.role === 'user')?.content.text ??
    'Chat'

  return (
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={AT_END_THRESHOLD_PX}>
      <ConversationSurface
        slug={slug}
        id={id}
        conversation={conversation.data}
        agent={agent}
        ownUserId={me.data?.id}
        title={title}
        animateArrival={animateArrival}
      />
    </MessageScrollerProvider>
  )
}

type ConversationSurfaceProps = {
  readonly slug: string
  readonly id: string
  readonly conversation: NonNullable<ReturnType<typeof useConversation>['data']>
  readonly agent: ChatAgent
  readonly ownUserId: string | undefined
  readonly title: string
  readonly animateArrival: boolean
}

function ConversationSurface({
  slug,
  id,
  conversation,
  agent,
  ownUserId,
  title,
  animateArrival,
}: ConversationSurfaceProps) {
  const { agentKind, messages, offers, working } = conversation
  const [pendingMessage, setPendingMessage] = useState<PendingUserMessage>()
  const currentTurn = turnOf(messages)
  const turns = useMemo(() => transcriptTurns(messages), [messages])
  const rows = useMemo(() => rowsWithPending(turns, pendingMessage), [pendingMessage, turns])
  const watching = useWatching(slug, id, currentTurn, ownUserId)
  const { scrollToEnd, scrollToMessage } = useMessageScroller()
  const viewport = useRef<HTMLDivElement>(null)
  const latestPrompt = useRef<LatestUserPrompt | null>(null)
  const positionedConversation = useRef<string | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)

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

  const noteScrollPosition = () => {
    const element = viewport.current
    if (element === null) return
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop
    setShowScrollButton(distance > AT_END_THRESHOLD_PX)
  }

  return (
    <section className="chat-screen" aria-label="Chat">
      <header className="chat-conversation-header">
        <strong>{title}</strong>
      </header>
      <MessageScroller className="chat-scroll-root">
        <MessageScrollerViewport
          ref={viewport}
          className="chat-scroll"
          onScroll={noteScrollPosition}
        >
          <MessageScrollerContent className="chat-scroll-content">
            <Transcript
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
          show={showScrollButton}
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
    </section>
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

function agentPresentation(agent: InstalledAgent | undefined, kind: string): ChatAgent {
  if (agent === undefined) return { avatarSrc: '', name: agentKindName(kind) }
  return { avatarSrc: agent.avatarUrl, name: agent.name?.trim() || agentKindName(kind) }
}

type AssistantMessage = Extract<Message, { readonly role: 'assistant' }>
type ReplyBlock =
  | { readonly kind: 'assistant'; readonly message: AssistantMessage }
  | { readonly kind: 'tools'; readonly messages: ToolMessage[] }
  | { readonly kind: 'activity'; readonly seq: number; readonly at: string; readonly text: string }

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
    if (text !== null) blocks.push({ kind: 'activity', seq: message.seq, at: message.at, text })
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
  messages,
  turns,
  turn,
  agent,
  animateArrival,
  working,
  liveTurn,
  pendingMessage,
}: {
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
                <ChatMessage
                  placement="right"
                  at={turn.user.at}
                  author={turn.user.said ?? 'Unknown person'}
                  copyText={turn.user.content.text}
                >
                  <ChatMessageText
                    message={turn.user}
                    animate={
                      turn.user.seq > (firstPaintEndsAt ?? 0) ||
                      (animateArrival && turn.user.seq === firstPaintEndsAt)
                    }
                  />
                </ChatMessage>
              ) : (
                <AgentReply messages={turn.reply} agent={agent} liveOutputs={liveTurn.outputs} />
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
  messages,
  agent,
  liveOutputs,
}: {
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
    .filter(
      (block): block is Extract<ReplyBlock, { readonly kind: 'assistant' }> =>
        block.kind === 'assistant',
    )
    .map((block) => block.message.content.text)
    .join('\n\n')

  return (
    <ChatMessage
      placement="left"
      at={beganAt}
      avatarSrc={agent.avatarSrc}
      author={agent.name}
      {...(copyText === '' ? {} : { copyText })}
    >
      <div className="chat-agent-reply">
        <ReplyContent blocks={blocks} liveOutputs={liveOutputs} />
      </div>
    </ChatMessage>
  )
}

function blockStartedAt(block: ReplyBlock): string | undefined {
  if (block.kind === 'assistant') return block.message.at
  if (block.kind === 'activity') return block.at
  return block.messages[0]?.at
}

function ReplyContent({
  blocks,
  liveOutputs,
}: {
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
          return (
            <p className="chat-line-activity" key={`activity-${String(block.seq)}`}>
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
