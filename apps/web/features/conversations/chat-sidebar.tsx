/**
 * What a Space has to talk to, and what has been said in it: the Chat sidebar.
 *
 * Agents first, then conversations by when they were started. Both come from the same queries the
 * screens themselves read — a second cache here would let a pin, or whether an agent is here,
 * disagree with the page beside it depending on which one somebody touched last.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { PinAngle, PinAngleFill } from 'react-bootstrap-icons'
import type { components } from '../../generated/api.ts'
import { AgentMark, agentKindName, agentName } from '../machines/agent.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import { ChatIcon } from '../spaces/sidebar-icons.tsx'
import { conversationsIn, useSetPinned } from './talking.ts'

type Conversation = components['schemas']['Conversation']

type ConversationGroup = {
  readonly label: 'Today' | 'Yesterday' | 'This week' | 'Earlier'
  readonly conversations: readonly Conversation[]
}

function dayStarted(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

function grouped(
  conversations: readonly Conversation[],
  now = new Date(),
): readonly ConversationGroup[] {
  const today = dayStarted(now)
  const yesterday = today - 86_400_000
  const week = today - 6 * 86_400_000
  const buckets = {
    Today: new Array<Conversation>(),
    Yesterday: new Array<Conversation>(),
    'This week': new Array<Conversation>(),
    Earlier: new Array<Conversation>(),
  } satisfies Record<ConversationGroup['label'], Conversation[]>

  for (const conversation of conversations) {
    const started = new Date(conversation.startedAt).getTime()
    if (started >= today) buckets.Today.push(conversation)
    else if (started >= yesterday) buckets.Yesterday.push(conversation)
    else if (started >= week) buckets['This week'].push(conversation)
    else buckets.Earlier.push(conversation)
  }

  const groups: ConversationGroup[] = []
  for (const [label, rows] of Object.entries(buckets) as [
    ConversationGroup['label'],
    Conversation[],
  ][]) {
    if (rows.length > 0) groups.push({ label, conversations: rows })
  }
  return groups
}

function groupId(label: ConversationGroup['label']): string {
  return `chat-group-${label.toLowerCase().replaceAll(' ', '-')}`
}

function ageOf(startedAt: string, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - new Date(startedAt).getTime())
  const hours = Math.floor(elapsedMs / 3_600_000)
  if (hours < 1) return 'now'
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(startedAt),
  )
}

/**
 * What a conversation is called, which is the first thing anybody said in it.
 *
 * Exported because the chat screen shows the same title over the same conversation, and the two
 * were saying different things about one with nothing in it — "New chat" here and "Chat" there.
 */
export function titleOf(conversation: { readonly opening: string | null } | undefined): string {
  const opening = conversation?.opening?.trim() ?? ''

  return opening === '' ? 'New chat' : opening
}

function AgentChoice({ slug, agent }: { readonly slug: string; readonly agent: InstalledAgent }) {
  const kindName = agentKindName(agent.kind)
  const name = agentName(agent.kind, agent.name)
  const availability = agent.isHere ? 'ready' : 'offline'
  // Its own name only when somebody gave it one. Unnamed, it is already showing its kind, and
  // "Claude Code, Claude Code on mina-mbp" says the same word twice for no reason.
  const said = name === kindName ? name : `${name}, ${kindName}`

  return (
    <li>
      <Link
        className="chat-agent"
        to="/s/$slug/a/$machineId/$agentKind"
        params={{ slug, machineId: agent.machineId, agentKind: agent.kind }}
        aria-label={`${said} on ${agent.machineName}, ${availability}`}
        data-online={agent.isHere}
      >
        <span className="chat-agent-avatar">
          <img src={agent.avatarUrl} alt="" width="44" height="44" />
          <span
            className="chat-agent-kind"
            data-kind={agent.kind}
            data-online={agent.isHere}
            aria-hidden="true"
          >
            <AgentMark kind={agent.kind} />
          </span>
        </span>
        <span className="chat-agent-name">{name}</span>
      </Link>
    </li>
  )
}

function ConversationRow({
  slug,
  conversation,
  showAge,
}: {
  readonly slug: string
  readonly conversation: Conversation
  readonly showAge: boolean
}) {
  const mark = useSetPinned(slug, conversation.id)
  const action = conversation.pinned ? 'Unpin' : 'Pin'

  return (
    <li className="chat-history-row">
      <Link
        className="chat-history-summary"
        to="/s/$slug/c/$id"
        params={{ slug, id: conversation.id }}
      >
        <ChatIcon />
        <span className="chat-history-title">{titleOf(conversation)}</span>
        {showAge && <time dateTime={conversation.startedAt}>{ageOf(conversation.startedAt)}</time>}
      </Link>
      <button
        className="chat-pin"
        type="button"
        aria-label={`${action} ${titleOf(conversation)}`}
        disabled={mark.isPending}
        onClick={() => {
          mark.mutate(!conversation.pinned)
        }}
      >
        {conversation.pinned ? <PinAngleFill aria-hidden /> : <PinAngle aria-hidden />}
      </button>
    </li>
  )
}

export function PinnedChats({ slug }: { readonly slug: string }) {
  const [expanded, setExpanded] = useState(true)
  const conversations = useQuery(conversationsIn(slug))
  const pinned = (conversations.data ?? []).filter((conversation) => conversation.pinned)

  return (
    <section className="pin-section" aria-labelledby="pin-heading">
      <button
        id="pin-heading"
        className="sidebar-section-heading"
        type="button"
        aria-expanded={expanded}
        aria-controls="pinned-conversations"
        onClick={() => {
          setExpanded((open) => !open)
        }}
      >
        Pin
      </button>
      {expanded && (
        <ul id="pinned-conversations" className="chat-history">
          {pinned.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              slug={slug}
              conversation={conversation}
              showAge={false}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export function ChatSidebar({ slug }: { readonly slug: string }) {
  const machines = useQuery(machinesIn(slug))
  const conversations = useQuery(conversationsIn(slug))
  const agents = agentsOn(machines.data ?? [])

  return (
    <div className="chat-sidebar-panel">
      <div className="chat-sidebar-scroll">
        <section className="chat-agents" aria-labelledby="agents-heading">
          <h2 id="agents-heading">Agents</h2>
          <ul>
            {agents.map((agent) => (
              <AgentChoice key={`${agent.machineId}/${agent.kind}`} slug={slug} agent={agent} />
            ))}
          </ul>
        </section>

        <div className="chat-groups">
          {grouped(conversations.data ?? []).map((group) => (
            <section key={group.label} aria-labelledby={groupId(group.label)}>
              <h2 id={groupId(group.label)}>{group.label}</h2>
              <ul className="chat-history">
                {group.conversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    slug={slug}
                    conversation={conversation}
                    showAge
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
