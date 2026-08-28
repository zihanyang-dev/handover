import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { components } from '../../generated/api.ts'
import { AgentMark } from '../machines/agent-mark.tsx'
import { machinesIn } from '../machines/machine-list.ts'
import { SendButton } from './composer-buttons.tsx'
import { askedWithChoices, ModelChoices } from './model-choices.tsx'
import { useBeginConversation } from './talking.ts'

type Machine = components['schemas']['Machine']
type Agent = Machine['agents'][number]

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

  const machine = machines.data.find((one) => one.id === machineId)
  const agent = machine?.agents.find((one) => one.kind === agentKind)
  if (machine === undefined || agent === undefined)
    return <p className="agent-start-state">This agent is not available.</p>

  return (
    <ReadyStart
      slug={slug}
      machineId={machineId}
      agent={agent}
      online={machine.presence.state !== 'gone'}
    />
  )
}

function ReadyStart({
  slug,
  machineId,
  agent,
  online,
}: {
  readonly slug: string
  readonly machineId: string
  readonly agent: Agent
  readonly online: boolean
}) {
  const navigate = useNavigate()
  const begin = useBeginConversation(slug)
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [id] = useState(() => crypto.randomUUID())
  const name = agent.name?.trim() || 'Unnamed agent'

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
              id,
              machineId,
              agentKind: agent.kind,
              asked: askedWithChoices(asked, model, effort),
            },
            {
              onSuccess: (conversationId) => {
                void navigate({
                  to: '/s/$slug/c/$id',
                  params: { slug, id: conversationId },
                })
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
              {whyNot(begin.error.message, name)}
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

function whyNot(reason: string, name: string): string {
  if (reason === 'machine-away') return `${name} is offline.`
  if (reason === 'agent-not-on-machine') return `${name} is no longer available.`
  return 'Could not send that. Try again.'
}
