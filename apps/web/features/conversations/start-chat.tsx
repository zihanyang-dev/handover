/**
 * One agent, before there is anything to say to it.
 *
 * Choosing an agent writes nothing: this screen is the choice, and the conversation begins at the
 * moment the first message is sent. Somebody who opens it and walks away leaves nothing behind,
 * which is why the history has no empty rows in it.
 */

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Composer, ComposerError, SendButton } from '../../components/ui/chat-composer.tsx'
import { Mark } from '../../mark.tsx'
import { AgentMark, agentName, agentTint } from '../machines/agent.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import { useBeginConversation } from './conversation.ts'
import { markMessageArrival } from './message-transition.ts'
import { askedWithChoices, ModelChoices } from './model-choices.tsx'

export function StartChat({
  slug,
  machineId,
  agentKind,
}: {
  readonly slug: string
  readonly machineId: string
  readonly agentKind: string
}) {
  const machines = useQuery(machinesIn(slug))
  if (machines.isPending)
    return (
      <p
        className="mx-auto w-[min(44rem,calc(100%-3rem))] pt-24 text-center text-ink-muted"
        role="status"
      >
        Looking…
      </p>
    )
  if (machines.isError)
    return (
      <p
        className="mx-auto w-[min(44rem,calc(100%-3rem))] pt-24 text-center text-ink-muted"
        role="alert"
      >
        Could not read this agent. Try again.
      </p>
    )

  const agent = agentsOn(machines.data).find(
    (one) => one.machineId === machineId && one.kind === agentKind,
  )
  if (agent === undefined)
    return (
      <p
        className="mx-auto w-[min(44rem,calc(100%-3rem))] pt-24 text-center text-ink-muted"
        role="alert"
      >
        This agent is not available.
      </p>
    )

  return <ReadyStart slug={slug} agent={agent} />
}

function ReadyStart({ slug, agent }: { readonly slug: string; readonly agent: InstalledAgent }) {
  const navigate = useNavigate()
  const begin = useBeginConversation(slug)
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [id, setId] = useState(() => crypto.randomUUID())
  const name = agentName(agent.kind, agent.name)
  const online = agent.isHere

  return (
    <section
      className="mx-auto flex min-h-full w-[min(44rem,calc(100%-3rem))] flex-col items-center pt-[clamp(5rem,16vh,7.5rem)] pb-8"
      aria-labelledby="agent-start-title"
    >
      <div className="chat-starter-mark" aria-hidden="true">
        <Mark state="idle" size={44} />
      </div>
      <h1
        className="mt-5 mb-8 text-center text-3xl/9 font-semibold text-ink"
        id="agent-start-title"
      >
        How can <span className={agentTint(agent.kind)}>{name}</span> help?
      </h1>

      <Composer
        label={`Message ${name}`}
        placeholder={`Ask ${name} anything…`}
        text={text}
        onText={setText}
        takesFocus
        disabled={!online}
        leading={
          <span className="chat-composer-avatar" aria-hidden>
            <img src={agent.avatarUrl} alt="" />
            <span className={`chat-composer-avatar-mark ${agentTint(agent.kind)}`}>
              <AgentMark kind={agent.kind} />
            </span>
          </span>
        }
        action={<SendButton disabled={!online || begin.isPending || text.trim() === ''} />}
        onSend={() => {
          begin.mutate(
            {
              params: { path: { slug } },
              body: {
                id,
                machineId: agent.machineId,
                agentKind: agent.kind,
                asked: askedWithChoices(text.trim(), model, effort),
              },
            },
            {
              onSuccess: (opened) => {
                markMessageArrival(opened.id)
                void navigate({
                  to: '/s/$slug/c/$id',
                  params: { slug, id: opened.id },
                })
              },
              onError: (error) => {
                if (error.reason === 'conversation-id-taken') setId(crypto.randomUUID())
              },
            },
          )
        }}
      >
        {!online && (
          <span
            className="inline-flex h-7 items-center gap-1.5 text-copy-xxs font-medium text-ink-muted"
            role="status"
          >
            <span className="size-1.5 rounded-full bg-ink-faint" aria-hidden />
            Offline
          </span>
        )}
        {begin.isError && <ComposerError>{whyNot(begin.error.reason, name)}</ComposerError>}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <ModelChoices
            offers={agent.models}
            agentKind={agent.kind}
            model={model}
            effort={effort}
            onModel={(next) => {
              setModel(next)
              setEffort('')
            }}
            onEffort={setEffort}
          />
        </div>
      </Composer>
    </section>
  )
}

/**
 * Why the first message did not land, in the words of whoever has to do something about it.
 *
 * The names are the server's own, from `conversation-api.ts`. Opening one is the last moment a
 * different machine can be chosen, so it is the only place `machine-not-here` is ever an answer.
 */
function whyNot(reason: string, name: string): string {
  if (reason === 'machine-not-here') return `${name} is offline.`
  if (reason === 'agent-not-on-machine') return `${name} is no longer available.`
  if (reason === 'unavailable') return `${name} is not in this Space any more.`
  if (reason === 'conversation-id-taken') return 'Something else already started here. Try again.'

  return 'Could not send that. Try again.'
}
