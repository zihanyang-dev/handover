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
import { AgentMark } from '../machines/agent-mark.tsx'
import { agentsOn, machinesIn, type InstalledAgent } from '../machines/machine-list.ts'
import { SendButton } from './composer-buttons.tsx'
import { askedWithChoices, ModelChoices } from './model-choices.tsx'
import { useBeginConversation } from './talking.ts'

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
  if (machines.isPending) return <p className="agent-start-state">Looking…</p>
  if (machines.isError)
    return <p className="agent-start-state">Could not read this agent. Try again.</p>

  const agent = agentsOn(machines.data).find(
    (one) => one.machineId === machineId && one.kind === agentKind,
  )
  if (agent === undefined) return <p className="agent-start-state">This agent is not available.</p>

  return <ReadyStart slug={slug} agent={agent} />
}

function ReadyStart({ slug, agent }: { readonly slug: string; readonly agent: InstalledAgent }) {
  const navigate = useNavigate()
  const begin = useBeginConversation(slug)
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [id] = useState(() => crypto.randomUUID())
  const name = agent.name?.trim() || 'Unnamed agent'
  const online = agent.isHere

  return (
    <section className="agent-start" aria-labelledby="agent-start-title">
      <div className="agent-start-avatar" aria-hidden="true">
        <img src={agent.avatarUrl} alt="" width="64" height="64" />
        <span className="agent-start-kind" data-kind={agent.kind}>
          <AgentMark kind={agent.kind} />
        </span>
      </div>
      <h1 id="agent-start-title">
        How can{' '}
        <span className="agent-start-name" data-kind={agent.kind}>
          {name}
        </span>{' '}
        help?
      </h1>

      <form
        className="agent-start-composer"
        onSubmit={(event) => {
          event.preventDefault()
          const asked = text.trim()
          if (asked === '' || !online) return
          begin.mutate(
            {
              params: { path: { slug } },
              body: {
                id,
                machineId: agent.machineId,
                agentKind: agent.kind,
                asked: askedWithChoices(asked, model, effort),
              },
            },
            {
              onSuccess: (opened) => {
                void navigate({ to: '/s/$slug/c/$id', params: { slug, id: opened.id } })
              },
            },
          )
        }}
      >
        <textarea
          autoFocus
          aria-label={`Message ${name}`}
          placeholder={`Ask ${name} anything…`}
          rows={3}
          value={text}
          disabled={!online}
          onChange={(event) => {
            setText(event.target.value)
          }}
        />
        <div className="agent-start-actions">
          {!online && (
            <span className="composer-error" role="alert">
              {name} is offline.
            </span>
          )}
          {begin.isError && (
            <span className="composer-error" role="alert">
              {whyNot(begin.error.reason, name)}
            </span>
          )}
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
          <SendButton disabled={!online || begin.isPending || text.trim() === ''} />
        </div>
      </form>
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
