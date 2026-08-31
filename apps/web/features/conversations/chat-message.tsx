import type { ReactNode } from 'react'
import { Copy } from '../../components/ui/copy.tsx'
import { MessageMarkdown } from '../../components/ui/message-markdown.tsx'
import type { Message } from './conversation.ts'

type Placement = 'left' | 'right'

export function ChatMessage({
  placement,
  at,
  avatarSrc,
  author,
  copyText,
  children,
}: {
  readonly placement: Placement
  readonly at: string
  readonly avatarSrc?: string
  readonly author?: string
  readonly copyText?: string
  readonly children: ReactNode
}) {
  return (
    <article className="chat-message" data-placement={placement}>
      <header className="chat-message-header">
        {placement === 'left' && avatarSrc !== undefined && avatarSrc !== '' && (
          <span className="chat-message-avatar" aria-hidden>
            <img src={avatarSrc} alt="" />
          </span>
        )}
        {author !== undefined && <strong className="chat-message-author">{author}</strong>}
        <time dateTime={at}>{relativeTime(at)}</time>
      </header>
      <div className="chat-message-body">{children}</div>
      <div className="chat-message-actions">
        {copyText !== undefined && copyText !== '' && (
          <div className="chat-message-action-menu">
            <Copy text={copyText} what="message" />
          </div>
        )}
      </div>
    </article>
  )
}

type ChatTextMessage = Extract<Message, { readonly role: 'user' | 'assistant' }>

/** The visible body of a user or assistant message, including partial Markdown while streaming. */
export function ChatMessageText({
  message,
  animate = false,
}: {
  readonly message: ChatTextMessage
  readonly animate?: boolean
}) {
  if (message.role === 'user')
    return (
      <div
        className="chat-line chat-line-person"
        data-entering={animate || undefined}
        data-message-seq={message.seq}
      >
        <MessageMarkdown>{message.content.text}</MessageMarkdown>
      </div>
    )

  return (
    <div className="chat-line chat-line-agent">
      <MessageMarkdown>{message.content.text}</MessageMarkdown>
    </div>
  )
}

function relativeTime(at: string, now = Date.now()): string {
  const elapsedMinutes = Math.max(0, Math.floor((now - new Date(at).getTime()) / 60_000))
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, 'minute')

  const hours = Math.floor(elapsedMinutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')

  const days = Math.floor(hours / 24)
  if (days < 7) return formatter.format(-days, 'day')
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(at))
}
