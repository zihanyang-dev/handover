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
import { CheckCircleFill, ChevronRight } from 'react-bootstrap-icons'
import { burstConfetti } from '../../components/ui/confetti-burst.ts'
import { ShellCommand } from '../../components/ui/shell-command.tsx'
import { meQuery } from '../identity/me.ts'
import { AgentMark, agentName } from '../machines/agent.tsx'
import { useMachineKey } from '../machines/machine-key.tsx'
import { machinesIn, WHILE_WAITING_FOR_ONE_MS } from '../machines/machine-list.ts'
import { STEP_EXIT_MS, Steps } from './steps.tsx'

function countdown(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`
}

function RegularCommandChoice({ onBack }: { readonly onBack: () => void }) {
  return (
    <button className="host-method" type="button" onClick={onBack}>
      Use the regular command
    </button>
  )
}

function SkipChoice({ onSkip }: { readonly onSkip: () => void }) {
  return (
    <button className="host-skip" type="button" onClick={onSkip}>
      <span>Skip for now</span>
      <ChevronRight aria-hidden />
    </button>
  )
}

function KeySetupTitle({
  status,
  onBack,
}: {
  readonly status: string | undefined
  readonly onBack: () => void
}) {
  return (
    <div className="host-setup-title">
      <span className="host-setup-title-copy">
        <strong>One-time key</strong>
        {status !== undefined && <small>{status}</small>}
      </span>
      <RegularCommandChoice onBack={onBack} />
    </div>
  )
}

/** The direct way in, disclosed only when somebody asks for the fallback. */
function KeyCommand({
  active,
  onBack,
  onSkip,
}: {
  readonly active: boolean
  readonly onBack: () => void
  readonly onSkip: () => void
}) {
  const key = useMachineKey(active)

  if (key.state === 'expired' || key.state === 'unavailable') {
    const expired = key.state === 'expired'
    const makeAnother = key.again

    return (
      <div className="host-setup">
        <div className="host-setup-body">
          <KeySetupTitle status={expired ? 'Expired' : 'Unavailable'} onBack={onBack} />
          <p className="host-key-message">
            {expired
              ? 'This key can no longer connect a machine.'
              : 'A one-time key could not be generated.'}
          </p>
          <button
            className="button button-primary host-key-refresh"
            type="button"
            onClick={makeAnother}
          >
            <span className="button-label">{expired ? 'Generate a new key' : 'Try again'}</span>
          </button>
        </div>
        <div className="host-method-row">
          <SkipChoice onSkip={onSkip} />
        </div>
      </div>
    )
  }

  if (key.state === 'making') {
    return (
      <div className="host-setup">
        <div className="host-setup-body">
          <KeySetupTitle status={undefined} onBack={onBack} />
          <div className="shell-snippet host-key-placeholder" aria-hidden />
          <StatusLine message="Preparing a one-time key…" onSkip={onSkip} />
        </div>
      </div>
    )
  }

  return (
    <div className="host-setup">
      <div className="host-setup-body">
        <KeySetupTitle status={`Expires in ${countdown(key.secondsLeft)}`} onBack={onBack} />
        <ShellCommand command={key.command} />
        <Waiting onSkip={onSkip} />
      </div>
    </div>
  )
}

function StatusLine({
  message,
  onSkip,
}: {
  readonly message: string
  readonly onSkip: () => void
}) {
  return (
    <div className="host-status-row">
      <div className="host-waiting" role="status">
        <span className="host-waiting-dot" aria-hidden />
        <span>{message}</span>
      </div>
      <SkipChoice onSkip={onSkip} />
    </div>
  )
}

function Waiting({ onSkip }: { readonly onSkip: () => void }) {
  return <StatusLine message="Waiting for a machine…" onSkip={onSkip} />
}

/** The normal code-and-approval path first; a key is an explicit fallback. */
function ConnectionCommand({ onSkip }: { readonly onSkip: () => void }) {
  const [usingKey, setUsingKey] = useState(false)

  return (
    <div className="host-command-switch">
      <div
        className="host-command-pane"
        data-active={!usingKey}
        aria-hidden={usingKey}
        inert={usingKey}
      >
        <div className="host-setup">
          <div className="host-setup-body">
            <div className="host-setup-title">
              <strong>Run in Terminal</strong>
              <button
                className="host-method"
                type="button"
                onClick={() => {
                  setUsingKey(true)
                }}
              >
                Use a key instead
              </button>
            </div>
            <ShellCommand command="handover connect" />
            <Waiting onSkip={onSkip} />
          </div>
        </div>
      </div>

      <div
        className="host-command-pane"
        data-active={usingKey}
        aria-hidden={!usingKey}
        inert={!usingKey}
      >
        <KeyCommand
          active={usingKey}
          onBack={() => {
            setUsingKey(false)
          }}
          onSkip={onSkip}
        />
      </div>
    </div>
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
                  <li key={agent.kind} className="host-agent" data-agent={agent.kind}>
                    <span className="host-agent-mark" aria-hidden>
                      <AgentMark kind={agent.kind} />
                    </span>
                    <span className="host-agent-copy">
                      <strong>{agentName(agent.kind)}</strong>
                      <small>{agent.version}</small>
                    </span>
                  </li>
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

/** The way out: the Space once a machine is in, looking around first when it is not. */
function Leave({
  arrived,
  spaceName,
  onGo,
}: {
  readonly arrived: boolean
  readonly spaceName: string | undefined
  readonly onGo: () => void
}) {
  if (arrived) {
    return (
      <button className="button button-primary" type="button" onClick={onGo}>
        <span className="button-label">Open {spaceName ?? 'your Space'}</span>
      </button>
    )
  }
  return null
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

        <section className="onboarding-content host-stack">
          <div className="auth-head host-head">
            <h1>Connect a machine</h1>
          </div>

          {slug !== undefined && (
            <div className="stack-tight">
              {!arrived && <ConnectionCommand onSkip={goIn} />}
              <Arrived slug={slug} />
            </div>
          )}

          <Leave arrived={arrived} spaceName={name} onGo={goIn} />
        </section>
      </div>
    </main>
  )
}
