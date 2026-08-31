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
import { agentName } from '../machines/agent.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import { titleOf } from './chat-sidebar.tsx'
import {
  CHAT_SCROLL_EDGE_PX,
  ConversationSurface,
  type ChatAgent,
} from './conversation-surface.tsx'
import { conversationsIn, useConversation } from './conversation.ts'
import { consumeMessageArrival } from './message-transition.ts'

export function Chat({ slug, id }: { readonly slug: string; readonly id: string }) {
  const conversation = useConversation(slug, id)
  const conversationTitle = useQuery({
    ...conversationsIn(slug),
    // The list is where a conversation's name lives, and it is the same name the sidebar shows.
    // Read out of the transcript instead, one screen called an empty conversation "Chat" and the
    // other called it "New chat", and neither was reading what the other read.
    select: (answer) => titleOf(answer.conversations.find((one) => one.id === id)),
  })
  const machines = useQuery(machinesIn(slug))
  const me = useQuery(meQuery)
  const [animateArrival] = useState(() => consumeMessageArrival(id))

  if (conversation.isPending)
    return (
      <p className="chat-screen-state" role="status">
        Looking…
      </p>
    )
  if (conversation.isError)
    return (
      <p className="chat-screen-state" role="alert">
        Could not read this chat. Try again.
      </p>
    )
  if (conversation.data === null) return <UnavailableChat slug={slug} />

  const { agentKind, machineId } = conversation.data
  // By id, never by the machine's name. Two people who both call a laptop `mbp` are two machines
  // with one name, and matching on it would put one of them's face on the other's conversation.
  const installed = agentsOn(machines.data ?? []).find(
    (agent) => agent.kind === agentKind && agent.machineId === machineId,
  )
  const agent = agentPresentation(installed, agentKind)
  const title = conversationTitle.data ?? titleOf(undefined)

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

/** An agent that is no longer installed still has a conversation, so its kind is all there is. */
function agentPresentation(agent: InstalledAgent | undefined, kind: string): ChatAgent {
  if (agent === undefined) return { avatarSrc: '', name: agentName(kind, null) }

  return {
    avatarSrc: agent.avatarUrl,
    name: agentName(agent.kind, agent.name),
    location: { machine: agent.machineName },
  }
}
