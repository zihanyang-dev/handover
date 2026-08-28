/**
 * The second step: a machine of one's own.
 *
 * Agents run on somebody's machine, not on ours, so nothing in a Space can do anything until one
 * is here. The regular command asks through the terminal and opens the existing approval page;
 * a direct key is the fallback for a machine where that link cannot be opened.
 */

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowClockwise,
  Check2,
  CheckCircleFill,
  ChevronRight,
  Pencil,
} from 'react-bootstrap-icons'
import { burstConfetti } from '../../components/ui/confetti-burst.ts'
import { ShellCommand } from '../../components/ui/shell-command.tsx'
import { meQuery } from '../identity/me.ts'
import { AgentMark, agentKindName } from '../machines/agent.tsx'
import { useMachineKey } from '../machines/machine-key.tsx'
import {
  type Machine,
  machinesIn,
  useNameAgent,
  WHILE_WAITING_FOR_ONE_MS,
} from '../machines/machine-list.ts'
import { STEP_EXIT_MS, Steps } from './steps.tsx'

function countdown(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`
}

function SkipChoice({ onSkip }: { readonly onSkip: () => void }) {
  return (
    <button className="host-skip" type="button" onClick={onSkip}>
      <span>Skip for now</span>
      <ChevronRight aria-hidden />
    </button>
  )
}

/** The direct way in, disclosed only when somebody asks for the fallback. */
function KeyCommand({ active, onSkip }: { readonly active: boolean; readonly onSkip: () => void }) {
  const key = useMachineKey(active)

  if (key.state === 'expired' || key.state === 'unavailable') {
    const expired = key.state === 'expired'

    return (
      <div className="host-setup">
        <div className="host-setup-body">
          <button className="host-key-refresh" type="button" onClick={key.again}>
            <ArrowClockwise aria-hidden />
            <span>{expired ? 'Generate a new key' : 'Try again'}</span>
          </button>
          <StatusLine message={expired ? 'Key expired' : 'Key unavailable'} onSkip={onSkip} quiet />
        </div>
      </div>
    )
  }

  if (key.state === 'making') {
    return (
      <div className="host-setup">
        <div className="host-setup-body">
          <div className="shell-snippet host-key-placeholder" aria-hidden />
          <StatusLine message="Preparing a one-time key…" onSkip={onSkip} />
        </div>
      </div>
    )
  }

  return (
    <div className="host-setup">
      <div className="host-setup-body">
        <ShellCommand command={key.command} />
        <StatusLine message={`Waiting · ${countdown(key.secondsLeft)} left`} onSkip={onSkip} />
      </div>
    </div>
  )
}

function StatusLine({
  message,
  onSkip,
  quiet = false,
}: {
  readonly message: string
  readonly onSkip: () => void
  readonly quiet?: boolean
}) {
  return (
    <div className="host-status-row">
      <div className="host-waiting" data-quiet={quiet || undefined} role="status">
        <span className="host-waiting-dot" aria-hidden />
        <span>{message}</span>
      </div>
      <SkipChoice onSkip={onSkip} />
    </div>
  )
}

/** The normal code-and-approval path first; a key is an explicit fallback. */
function ConnectionCommand({ onSkip }: { readonly onSkip: () => void }) {
  const [usingKey, setUsingKey] = useState(false)

  return (
    <div className="host-command-switch">
      <div
        className="host-method-picker"
        data-method={usingKey ? 'key' : 'terminal'}
        role="group"
        aria-label="Connection method"
      >
        <button
          type="button"
          aria-label="Use the regular command"
          aria-pressed={!usingKey}
          data-active={!usingKey}
          onClick={() => {
            setUsingKey(false)
          }}
        >
          Terminal
        </button>
        <button
          type="button"
          aria-label="Use a key instead"
          aria-pressed={usingKey}
          data-active={usingKey}
          onClick={() => {
            setUsingKey(true)
          }}
        >
          One-time key
        </button>
      </div>

      <div className="host-command-panes">
        <div
          className="host-command-pane"
          data-active={!usingKey}
          aria-hidden={usingKey}
          inert={usingKey}
        >
          <div className="host-setup">
            <div className="host-setup-body">
              <ShellCommand command="handover connect" />
              <StatusLine message="Waiting for a machine…" onSkip={onSkip} />
            </div>
          </div>
        </div>

        <div
          className="host-command-pane"
          data-active={usingKey}
          aria-hidden={!usingKey}
          inert={!usingKey}
        >
          <KeyCommand active={usingKey} onSkip={onSkip} />
        </div>
      </div>
    </div>
  )
}

function HostAgentCard({
  slug,
  machine,
  agent,
}: {
  readonly slug: string
  readonly machine: Machine
  readonly agent: Machine['agents'][number]
}) {
  const kindName = agentKindName(agent.kind)

  return (
    <li className="host-agent" data-agent={agent.kind}>
      <span className="host-agent-avatar" aria-hidden>
        <img src={agent.avatarUrl} alt="" width="48" height="48" />
        <span className="host-agent-mark">
          <AgentMark kind={agent.kind} />
        </span>
      </span>
      <span className="host-agent-copy">
        {machine.yours ? (
          <AgentName slug={slug} machineId={machine.id} agent={agent} />
        ) : (
          <strong>{agent.name?.trim() || 'Unnamed agent'}</strong>
        )}
        <small>
          {kindName} · {agent.version}
        </small>
      </span>
    </li>
  )
}

function AgentName({
  slug,
  machineId,
  agent,
}: {
  readonly slug: string
  readonly machineId: string
  readonly agent: Machine['agents'][number]
}) {
  const kindName = agentKindName(agent.kind)
  const [name, setName] = useState(agent.name ?? '')
  const [editing, setEditing] = useState(false)
  const naming = useNameAgent(slug)

  const control = editing ? (
    <AgentNameForm
      type={kindName}
      name={name}
      pending={naming.isPending}
      onName={setName}
      onCancel={() => {
        setName(agent.name ?? '')
        setEditing(false)
      }}
      onSave={() => {
        if (name.trim() === (agent.name ?? '')) {
          setEditing(false)
          return
        }
        naming.mutate(
          {
            params: { path: { id: machineId, kind: agent.kind } },
            body: { name: name.trim() || null },
          },
          {
            onSuccess: () => {
              setEditing(false)
            },
          },
        )
      }}
    />
  ) : (
    <span className="host-agent-name-view">
      <strong data-empty={name.trim() === '' || undefined}>
        {name.trim() || 'Name this agent'}
      </strong>
      <button
        type="button"
        aria-label={`Edit ${kindName} name`}
        onClick={() => {
          setEditing(true)
        }}
      >
        <Pencil aria-hidden />
      </button>
    </span>
  )

  return (
    <>
      {control}
      {naming.isError && <span className="host-agent-name-error">Could not save.</span>}
    </>
  )
}

function AgentNameForm({
  type,
  name,
  pending,
  onName,
  onCancel,
  onSave,
}: {
  readonly type: string
  readonly name: string
  readonly pending: boolean
  readonly onName: (name: string) => void
  readonly onCancel: () => void
  readonly onSave: () => void
}) {
  return (
    <form
      className="host-agent-name"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <input
        autoFocus
        aria-label={`Name ${type}`}
        maxLength={48}
        placeholder={`Name ${type}`}
        value={name}
        onChange={(event) => {
          onName(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      />
      <button type="submit" aria-label={`Save ${type} name`} disabled={pending}>
        <Check2 aria-hidden />
      </button>
    </form>
  )
}

/** The machines that arrived, with what each of them found. */
function Arrived({ slug }: { readonly slug: string }) {
  const machines = useQuery(machinesIn(slug, WHILE_WAITING_FOR_ONE_MS))
  const found = (machines.data ?? []).filter((machine) => machine.presence.state === 'here')

  if (found.length === 0) return null

  return (
    <div className="host-arrived-list">
      {found.map((machine) => (
        <section
          key={machine.id}
          className="host-arrived-machine"
          aria-label={`${machine.name} connected`}
        >
          <p className="said said-good">
            <CheckCircleFill aria-hidden />
            <span className="host-machine-connected">{machine.name} is connected.</span>
          </p>

          {machine.agents.length === 0 ? (
            <p className="host-agents-empty">No agents found on it yet.</p>
          ) : (
            <>
              <p className="host-agents-label">Agents found</p>
              <ul className="host-agent-list" aria-label={`Agents found on ${machine.name}`}>
                {machine.agents.map((agent) => (
                  <HostAgentCard
                    key={`${agent.kind}:${agent.name ?? ''}`}
                    slug={slug}
                    machine={machine}
                    agent={agent}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  )
}

/** The Space this step is for: named in the address, or the only one there is. */
function useHostSpace(forSlug: string | undefined): {
  readonly slug: string | undefined
  readonly name: string | undefined
} {
  const navigate = useNavigate()
  // A create hands its response into this cache before navigating. Reuse it instead of issuing a
  // third /me read behind the route's own authentication check.
  const me = useQuery({ ...meQuery, staleTime: 30_000 })
  const spaces = me.data?.spaces ?? []
  const slug = forSlug ?? (spaces.length === 1 ? spaces[0]?.slug : undefined)

  useEffect(() => {
    // The address naming a Space is proof enough: the form that made it just sent us here, and
    // the /me cache may not have caught up. Only without one do we look at the list — and then
    // exactly one is derivable, anything else goes back to the step that makes or picks it.
    if (me.isSuccess && forSlug === undefined && spaces.length !== 1) {
      void navigate({ to: '/onboarding', replace: true })
    }
  }, [me.isSuccess, spaces.length, forSlug, navigate])

  return { slug, name: spaces.find((one) => one.slug === slug)?.displayName }
}

export function ConnectHost({ forSlug }: { readonly forSlug: string | undefined }) {
  const navigate = useNavigate()
  const { slug, name } = useHostSpace(forSlug)
  /** Where somebody clicked their way in. The bar sweeps to the end before the page follows. */
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  const machines = useQuery({
    ...machinesIn(slug ?? '', WHILE_WAITING_FOR_ONE_MS),
    enabled: slug !== undefined,
  })
  const arrived = (machines.data ?? []).some((machine) => machine.presence.state === 'here')

  const goIn = () => {
    if (slug === undefined) return
    burstConfetti()
    setLeaving(true)
    timer.current = setTimeout(() => {
      void navigate({ to: '/s/$slug', params: { slug } })
    }, STEP_EXIT_MS)
  }

  return (
    <main className="auth onboarding-page">
      <div className="onboarding-shell">
        <Steps step={2} done={leaving} mark={leaving || arrived ? 'success' : 'working'} />

        <section className="onboarding-content onboarding-step-card host-stack">
          <div className="auth-head host-head">
            <h1>Connect a machine</h1>
          </div>

          {slug !== undefined && (
            <div className="stack-tight">
              {!arrived && <ConnectionCommand onSkip={goIn} />}
              <Arrived slug={slug} />
            </div>
          )}

          {arrived && (
            <button className="button button-primary" type="button" onClick={goIn}>
              <span className="button-label">Open {name ?? 'your Space'}</span>
            </button>
          )}
        </section>
      </div>
    </main>
  )
}
