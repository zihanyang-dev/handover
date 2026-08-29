/**
 * Loads one conversation and hands the complete answer to its one visual surface.
 *
 * Query ownership stays here. Transcript geometry, live activity, the composer, and the work rail
 * stay together in conversation-surface.tsx so no second screen can own their scroll state.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { MessageScrollerProvider } from '../../components/ui/message-scroller.tsx'
import { meQuery } from '../identity/me.ts'
import { agentKindName } from '../machines/agent.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import {
  CHAT_SCROLL_EDGE_PX,
  ConversationSurface,
  type ChatAgent,
} from './conversation-surface.tsx'
import { consumeMessageArrival } from './message-transition.ts'
import { conversationsIn, useConversation } from './talking.ts'

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
  if (conversation.data === null) return <UnavailableChat slug={slug} />

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
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={CHAT_SCROLL_EDGE_PX}>
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

function UnavailableChat({ slug }: { readonly slug: string }) {
  return (
    <div className="chat-screen-state">
      <p>This chat is not available.</p>
      <Link to="/s/$slug" params={{ slug }}>
        Back to the Space
      </Link>
    </div>
  )
}

function agentPresentation(agent: InstalledAgent | undefined, kind: string): ChatAgent {
  if (agent === undefined) return { avatarSrc: '', name: agentKindName(kind) }
  return { avatarSrc: agent.avatarUrl, name: agent.name?.trim() || agentKindName(kind) }
}
