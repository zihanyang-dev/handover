/**
 * One conversation, read and spoken into.
 *
 * Two things are on screen at once and only one of them survives: the transcript, which is
 * everything that was written down, and the live line under it, which is what is happening this
 * moment and is kept nowhere. They come from different places on purpose — see `talking.ts`.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDown, Check, ChevronRight, FileDiff, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Composer,
  ComposerError,
  SendButton,
  StopButton,
} from '../../components/ui/chat-composer.tsx'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '../../components/ui/message-scroller.tsx'
import { AgentMark, agentName as agentKindName, agentTint } from '../machines/agent.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import { ChatActivity } from './chat-activity.tsx'
import { ChatMessage, ChatMessageText } from './chat-message.tsx'
import { consumeMessageArrival } from './message-transition.ts'
import { askedWithChoices, ModelChoices, type Model } from './model-choices.tsx'
import {
  conversationsIn,
  useConversation,
  useSay,
  useStop,
  useWatching,
  type LiveOutput,
  type LiveTurn,
  type Message,
  type Working,
} from './talking.ts'
import {
  getLatestUserPrompt,
  shouldPinForNewPrompt,
  type LatestUserPrompt,
  type TranscriptRow,
} from './transcript-scroll.ts'

const AT_END_THRESHOLD_PX = 48
const PROMPT_TOP_GAP_PX = 24

type UserMessage = Extract<Message, { readonly role: 'user' }>

export function Chat({ slug, id }: { readonly slug: string; readonly id: string }) {
  const conversation = useConversation(slug, id)
  const conversationTitle = useQuery({
    ...conversationsIn(slug),
    select: (answer) => answer.conversations.find((one) => one.id === id)?.opening,
  })
  const machines = useQuery(machinesIn(slug))
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
        title={title}
        animateArrival={animateArrival}
      />
    </MessageScrollerProvider>
  )
}

function ConversationSurface({
  slug,
  id,
  conversation,
  agent,
  title,
  animateArrival,
}: {
  readonly slug: string
  readonly id: string
  readonly conversation: NonNullable<ReturnType<typeof useConversation>['data']>
  readonly agent: { readonly avatarSrc: string; readonly name: string }
  readonly title: string
  readonly animateArrival: boolean
}) {
  const { agentKind, messages, offers, working } = conversation
  const [pendingMessage, setPendingMessage] = useState<UserMessage>()
  const turns = useMemo(() => transcriptTurns(messages), [messages])
  const rows = useMemo(() => rowsWithPending(turns, pendingMessage), [pendingMessage, turns])
  const liveTurn = useWatching(slug, id, turnOf(messages))
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
    if (!shouldPinForNewPrompt(previousPrompt, nextPrompt) || nextPrompt === null) return
    scrollToMessage(nextPrompt.rowId, {
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
              agent={agent}
              animateArrival={animateArrival}
              working={working.state === 'working'}
              liveTurn={liveTurn}
              pendingMessage={pendingMessage}
            />
            {working.state === 'unknown' && (
              <div className="chat-transcript-footer">
                <WorkingState working={working} />
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
          <SayInto
            slug={slug}
            id={id}
            offers={offers}
            agentKind={agentKind}
            agentName={agent.name}
            avatarSrc={agent.avatarSrc}
            working={working.state === 'working'}
            turn={turnOf(messages)}
            afterSeq={messages.at(-1)?.seq ?? 0}
            onPending={setPendingMessage}
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

function agentPresentation(agent: InstalledAgent | undefined, kind: string) {
  if (agent === undefined) return { avatarSrc: '', name: agentKindName(kind) }
  return { avatarSrc: agent.avatarUrl, name: agent.name?.trim() || agentKindName(kind) }
}

type ToolMessage = Message & { readonly role: 'tool' }
type AssistantMessage = Message & { readonly role: 'assistant' }
type ReplyBlock =
  | { readonly kind: 'assistant'; readonly message: AssistantMessage }
  | { readonly kind: 'tools'; readonly messages: ToolMessage[] }

function replyBlocks(messages: readonly Message[]): ReplyBlock[] {
  const blocks: ReplyBlock[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      blocks.push({ kind: 'assistant', message })
      continue
    }
    if (message.role !== 'tool') continue

    const previous = blocks.at(-1)
    if (previous?.kind === 'tools') previous.messages.push(message)
    else blocks.push({ kind: 'tools', messages: [message] })
  }
  return blocks
}

type TranscriptTurn =
  | { readonly key: string; readonly user: Message & { readonly role: 'user' } }
  | { readonly key: string; readonly reply: Message[] }

function transcriptTurns(messages: readonly Message[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const message of messages) addTranscriptTurn(turns, message)
  return turns
}

function transcriptRows(turns: readonly TranscriptTurn[]): TranscriptRow[] {
  return turns.map(transcriptRow)
}

function rowsWithPending(
  turns: readonly TranscriptTurn[],
  pending: UserMessage | undefined,
): readonly TranscriptRow[] {
  const written = transcriptRows(turns)
  return pending === undefined
    ? written
    : [...written, { id: 'pending-user', kind: 'user', seq: pending.seq }]
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
  agent,
  animateArrival,
  working,
  liveTurn,
  pendingMessage,
}: {
  readonly messages: readonly Message[]
  readonly turns: readonly TranscriptTurn[]
  readonly agent: { readonly avatarSrc: string; readonly name: string }
  readonly animateArrival: boolean
  readonly working: boolean
  readonly liveTurn: LiveTurn
  readonly pendingMessage: UserMessage | undefined
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
      {working && !activeCallIsWritten && (
        <MessageScrollerItem messageId={`live-${String(turnOf(messages))}`}>
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
  readonly agent: { readonly avatarSrc: string; readonly name: string }
  readonly liveOutputs: ReadonlyMap<string, LiveOutput>
}) {
  const blocks = replyBlocks(messages)
  const first = blocks[0]
  if (first === undefined) return null
  const beganAt = first.kind === 'assistant' ? first.message.at : first.messages[0]?.at
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
      agentName={agent.name}
      copyText={copyText || undefined}
    >
      <div className="chat-agent-reply">
        <ReplyContent blocks={blocks} liveOutputs={liveOutputs} />
      </div>
    </ChatMessage>
  )
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
      {blocks.map((block) =>
        block.kind === 'tools' ? (
          <ToolRun
            key={`tools-${String(block.messages[0]?.seq ?? 0)}`}
            messages={block.messages}
            liveOutputs={liveOutputs}
          />
        ) : (
          <ChatMessageText key={`answer-${String(block.message.seq)}`} message={block.message} />
        ),
      )}
    </div>
  )
}

function ToolRun({
  messages,
  liveOutputs,
}: {
  readonly messages: readonly ToolMessage[]
  readonly liveOutputs: ReadonlyMap<string, LiveOutput>
}) {
  const hasLiveOutput = messages.some((message) => outputFor(message, liveOutputs) !== undefined)
  const [open, setOpen] = useState(hasLiveOutput)
  const label = `Ran ${String(messages.length)} ${messages.length === 1 ? 'step' : 'steps'}`

  return (
    <div className="chat-tool-run">
      <button
        type="button"
        className="chat-tool-run-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        <span className="chat-tool-run-label">
          {label}
          <AccordionChevron />
        </span>
      </button>
      <div
        className="chat-tool-run-body"
        data-open={open || undefined}
        aria-hidden={!open}
        inert={!open}
      >
        <div>
          <div className="chat-tool-rows">
            {messages.map((message) => (
              <ToolRow key={message.seq} message={message} liveOutputs={liveOutputs} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function toolLabel(message: ToolMessage) {
  const { name, verb } = message.content
  if (/^agent/iu.test(name)) return 'Delegating work'
  if (/toolsearch/iu.test(name)) return 'Finding a tool'
  if (/websearch/iu.test(name)) return 'Searching the web'
  if (/webfetch/iu.test(name)) return 'Fetching a page'
  return toolTone(`${verb} ${name}`) === 'run' ? 'Run' : verb || name
}

function ToolRow({
  message,
  liveOutputs,
}: {
  readonly message: ToolMessage
  readonly liveOutputs: ReadonlyMap<string, LiveOutput>
}) {
  const liveOutput = outputFor(message, liveOutputs)
  const [expanded, setExpanded] = useState(liveOutput !== undefined)
  const { arg, name, ok } = message.content
  const label = toolLabel(message)
  const changed = toolCounts(message).changed

  return (
    <div className="chat-tool-row" data-ok={ok === false ? 'false' : 'true'}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current)
        }}
      >
        <span className="chat-tool-row-icon" aria-hidden>
          {ok === false ? <X /> : <Check />}
        </span>
        <span className="chat-tool-row-copy">
          <strong>{label}</strong>
          <span className="chat-tool-chip">{arg || name}</span>
        </span>
        {!changed && <AccordionChevron />}
      </button>
      {changed && (
        <DiffChip
          message={message}
          expanded={expanded}
          onToggle={() => {
            setExpanded((current) => !current)
          }}
        />
      )}
      <div
        className="chat-tool-detail"
        data-open={expanded || undefined}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div>
          <ToolOutput message={message} liveOutput={liveOutput} />
        </div>
      </div>
    </div>
  )
}

function outputFor(
  message: ToolMessage,
  liveOutputs: ReadonlyMap<string, LiveOutput>,
): LiveOutput | undefined {
  const { callId } = message.content
  return callId === undefined ? undefined : liveOutputs.get(callId)
}

function ToolOutput({
  message,
  liveOutput,
}: {
  readonly message: ToolMessage
  readonly liveOutput: LiveOutput | undefined
}) {
  const durable = message.content.excerpt
  const preferDurable = liveOutput?.truncated === true && durable.length > liveOutput.text.length
  const text = preferDurable ? durable : liveOutput?.text || durable
  if (text === '') return null
  return (
    <ToolDetail
      excerpt={text}
      command={message.content.arg}
      truncated={!preferDurable && liveOutput?.truncated === true}
    />
  )
}

function ToolDetail({
  excerpt,
  command,
  truncated = false,
}: {
  readonly excerpt: string
  readonly command: string
  readonly truncated?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const lines = excerpt.split('\n')
  const visibleLines =
    command.trim() !== '' && lines[0]?.trim() === command.trim() ? lines.slice(1) : lines
  const long = visibleLines.length > 7 || visibleLines.join('\n').length > 500

  return (
    <div className="chat-tool-output" data-clamped={(long && !showAll) || undefined}>
      <span className="chat-tool-output-truncated" hidden={!truncated}>
        Earlier output truncated
      </span>
      <code>
        {visibleLines.map((line, index) => (
          <span className="chat-tool-output-line" data-tone={toolLineTone(line)} key={index}>
            {line === '' ? ' ' : line}
          </span>
        ))}
      </code>
      {long && (
        <button
          type="button"
          className="chat-tool-show-all"
          aria-expanded={showAll}
          onClick={() => {
            setShowAll((current) => !current)
          }}
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

function toolLineTone(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'delete'
  if (/^(?:✓|✔|passed\b|success\b)/iu.test(line.trim())) return 'success'
  if (/^(?:✗|✘|error\b|failed\b)/iu.test(line.trim())) return 'failure'
  return 'plain'
}

function toolTone(label: string) {
  if (/edit|write|patch/iu.test(label)) return 'edit'
  if (/run|bash|command|exec/iu.test(label)) return 'run'
  if (/read|search|find|list/iu.test(label)) return 'read'
  return 'plain'
}

function AccordionChevron() {
  return <ChevronRight className="chat-accordion-chevron" aria-hidden />
}

function DiffChip({
  message,
  expanded,
  onToggle,
}: {
  readonly message: ToolMessage
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const counts = toolCounts(message)
  const file = message.content.arg || message.content.name

  return (
    <div className="chat-diff-chip-wrap">
      <button
        type="button"
        aria-label={`Show diff for ${file}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <FileDiff className="chat-diff-icon" aria-hidden />
        <span>{file}</span>
        {counts.additions > 0 && <b>+{counts.additions}</b>}
        {counts.deletions > 0 && <i>−{counts.deletions}</i>}
        <AccordionChevron />
      </button>
    </div>
  )
}

function toolCounts(message: ToolMessage) {
  const lines = message.content.excerpt.split('\n')
  const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  return { additions, deletions, changed: additions > 0 || deletions > 0 }
}

/** The composer as this screen wires it: what is said goes into the conversation it is under. */
function SayInto({
  slug,
  id,
  offers,
  agentKind,
  agentName,
  avatarSrc,
  working,
  turn,
  afterSeq,
  onPending,
}: {
  readonly slug: string
  readonly id: string
  readonly offers: readonly Model[]
  readonly agentKind: string
  readonly agentName: string
  readonly avatarSrc: string
  readonly working: boolean
  readonly turn: number
  readonly afterSeq: number
  readonly onPending: (message: UserMessage | undefined) => void
}) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const say = useSay(slug, id)
  const stop = useStop(slug, id)

  return (
    <Composer
      label={`Message ${agentName}`}
      placeholder={`Ask ${agentName} anything…`}
      text={text}
      onText={setText}
      disabled={say.isPending}
      leading={<ComposerAvatar avatarSrc={avatarSrc} agentKind={agentKind} />}
      action={
        working ? (
          <StopButton
            disabled={stop.isPending}
            onStop={() => {
              stop.mutate({
                params: { path: { slug, id } },
                body: { key: `${String(turn)}/stop` },
              })
            }}
          />
        ) : (
          <SendButton disabled={say.isPending || text.trim() === ''} />
        )
      }
      onSend={() => {
        if (working) return
        const sentText = text.trim()
        const asked = askedWithChoices(sentText, model, effort)
        onPending({
          role: 'user',
          seq: afterSeq + 1,
          at: new Date().toISOString(),
          said: null,
          content: asked,
        })
        setText('')
        say.mutate(asked, {
          onSuccess: () => {
            onPending(undefined)
          },
          onError: () => {
            onPending(undefined)
            setText(sentText)
          },
        })
      }}
    >
      {say.isError && <ComposerError>{whyNot(say.error.reason)}</ComposerError>}
      {stop.isError && <ComposerError>Could not stop it. Try again.</ComposerError>}
      <ModelChoices
        offers={offers}
        agentKind={agentKind}
        model={model}
        effort={effort}
        onModel={(next) => {
          setModel(next)
          setEffort('')
        }}
        onEffort={setEffort}
      />
    </Composer>
  )
}

function ComposerAvatar({
  avatarSrc,
  agentKind,
}: {
  readonly avatarSrc: string
  readonly agentKind: string
}) {
  return (
    <span className="chat-composer-avatar" aria-hidden>
      {avatarSrc !== '' && <img src={avatarSrc} alt="" />}
      <span className={`chat-composer-avatar-mark ${agentTint(agentKind)}`}>
        <AgentMark kind={agentKind} />
      </span>
    </span>
  )
}

function WorkingState({ working }: { readonly working: Working }) {
  if (working.state === 'unknown')
    return (
      <p className="chat-working" role="status" aria-live="polite">
        Nobody knows how that turn ended.
      </p>
    )
  return null
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

/**
 * Why what was said did not land.
 *
 * A machine that is not here is deliberately not among these: words said into a conversation that
 * already exists are written down whether or not its laptop is open, and the turn carries them
 * when it asks again. Only opening one can be refused for that — see `start-chat.tsx`.
 */
function whyNot(reason: string): string {
  if (reason === 'agent-not-on-machine') return 'This agent is no longer installed.'
  if (reason === 'unavailable') return 'This conversation is not here any more.'

  return 'Could not send that. Try again.'
}
