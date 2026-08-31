/**
 * Answering a machine that is asking to come in.
 *
 * Two things have to be true before saying yes means anything: this is the code that machine
 * showed, and it is the machine somebody just ran a command on. The screen also names the account
 * it will belong to; a machine belongs to that person, not to whichever Space was open.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { CheckCircleFill, ExclamationCircleFill, Laptop } from 'react-bootstrap-icons'
import { api, cached, reasonOf } from '../../api.ts'
import { ShellCommand } from '../../components/ui/shell-command.tsx'
import type { components } from '../../generated/api.ts'
import { Mark } from '../../mark.tsx'
import { meQuery } from '../identity/me.ts'

function saidFor(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case undefined:
      return fallback
    case 'no-enrolment':
      return 'Nothing is waiting under that code. Check the terminal, or run it again.'
    case 'unavailable':
      return 'That Space is not available.'
    case 'machine-unavailable':
      return 'That existing machine is no longer available. Find the code again.'
    default:
      return fallback
  }
}

export function connectSearch(search: Record<string, unknown>): { space?: string } {
  const space = search['space']
  return typeof space === 'string' ? { space } : {}
}

function waitingFor(code: string) {
  return cached.queryOptions(
    'get',
    '/enrolments/{userCode}',
    { params: { path: { userCode: code } } },
    // Nothing to ask about until somebody has typed one, and a code that is not right does not
    // become right: asking again is three more seconds of "Looking…" before the same answer.
    { enabled: code !== '', retry: false },
  )
}

/**
 * The half that is answered, once there is something to answer about.
 *
 * One question and one answer: is that your machine. The machine and CLI never choose a Space.
 * When this page came from a Space's Add machine journey, that destination is already explicit and
 * is said before approval; the Account journey leaves the machine private.
 */
type ExistingMachine = components['schemas']['MachineWaiting']['existingMachines'][number]

type AnswerDecision =
  { readonly kind: 'approve'; readonly replaceMachineId?: string } | { readonly kind: 'refuse' }

function whereaboutsOf(machine: ExistingMachine): string {
  const presence = machine.presence.state === 'here' ? 'Online' : 'Offline'
  const connected = `connected ${new Date(machine.createdAt).toLocaleDateString()}`
  return `${presence} · ${connected}`
}

function ReconnectChoice({
  machine,
  pending,
  onAnswer,
}: {
  readonly machine: ExistingMachine
  readonly pending: boolean
  readonly onAnswer: (decision: AnswerDecision) => void
}) {
  const whereabouts = whereaboutsOf(machine)
  return (
    <button
      className="button button-primary h-auto min-h-11 flex-col items-start gap-0.5 py-2 text-left"
      type="button"
      disabled={pending}
      aria-label={`Yes, reconnect it, ${whereabouts}`}
      onClick={() => {
        onAnswer({ kind: 'approve', replaceMachineId: machine.id })
      }}
    >
      <span className="button-label">Yes, reconnect it</span>
      <span className="text-[11px] font-normal opacity-80">{whereabouts}</span>
    </button>
  )
}

function ApprovalChoices({
  machines,
  pending,
  onAnswer,
}: {
  readonly machines: readonly ExistingMachine[]
  readonly pending: boolean
  readonly onAnswer: (decision: AnswerDecision) => void
}) {
  if (machines.length === 0) {
    return (
      <button
        className="button button-primary"
        type="button"
        disabled={pending}
        onClick={() => {
          onAnswer({ kind: 'approve' })
        }}
      >
        <span className="button-label">Yes, that is mine</span>
      </button>
    )
  }

  return (
    <fieldset className="flex w-full flex-col gap-2">
      <legend className="sr-only">Connection choice</legend>
      <p className="note m-0">Have you connected this machine before?</p>
      <p className="note m-0">
        Reconnect it to keep its chats and Agent settings. The old connection will stop.
      </p>
      {machines.map((machine) => (
        <ReconnectChoice key={machine.id} machine={machine} pending={pending} onAnswer={onAnswer} />
      ))}
      <button
        className="button min-h-9 border border-line-firm bg-transparent text-ink-body shadow-none"
        type="button"
        disabled={pending}
        onClick={() => {
          onAnswer({ kind: 'approve' })
        }}
      >
        <span className="button-label">No, this is a different machine</span>
      </button>
    </fieldset>
  )
}

type AnswerProps = {
  readonly machineName: string
  readonly existingMachines: readonly ExistingMachine[]
  readonly who: string
  readonly spaceName: string | undefined
  readonly pending: boolean
  readonly onAnswer: (decision: AnswerDecision) => void
}

function Answer({ machineName, existingMachines, who, spaceName, pending, onAnswer }: AnswerProps) {
  return (
    <div className="connect-answer">
      <p className="said said-good" role="status">
        <Laptop aria-hidden />
        <strong>{machineName}</strong> is asking to come in. Is that the machine you just ran the
        command on?
      </p>
      <ApprovalChoices machines={existingMachines} pending={pending} onAnswer={onAnswer} />

      {/* Whose it will be, said before it is agreed to. Somebody signing in with a way in that
          turns out to have its own account would otherwise attach their laptop to an account
          they did not mean — and be sure they had, because on their other one they do. */}
      <p className="note">
        It will be yours, as <strong>{who}</strong>.
        {spaceName === undefined
          ? ' You can add it to a Space afterwards.'
          : ` It will also be available in ${spaceName}.`}
      </p>
      <button
        className="button h-7 min-h-7 rounded-[var(--interaction-radius)] border-0 bg-transparent px-2 py-0 text-copy-xs font-normal text-ink shadow-none transition-colors duration-100 ease-in-out enabled:hover:bg-[var(--interaction-hover)] enabled:active:bg-[var(--interaction-pressed)] focus-visible:shadow-[0_0_0_2px_var(--base),0_0_0_4px_var(--focus)]"
        type="button"
        disabled={pending}
        onClick={() => {
          onAnswer({ kind: 'refuse' })
        }}
      >
        <span className="button-label">That is not mine — turn it away</span>
      </button>
    </div>
  )
}

/** The screen after answering. Nothing of the form survives onto it, so it is not part of it. */
function Answered({ letIn }: { readonly letIn: boolean }) {
  return (
    <main className="connect-page">
      <section className="step-card connect-card connect-result">
        <p className="said said-good" role="status">
          <CheckCircleFill aria-hidden />
          {letIn ? 'That machine is in. Its terminal will say so.' : 'Turned away.'}
        </p>
      </section>
    </main>
  )
}

/**
 * Something did not work. Words where there are words for it, and never the word off the wire.
 *
 * The refusal arrives as itself rather than as a sentence squeezed into an `Error`: a reason is a
 * value the contract names, and a page that read it back out of a message string would break the
 * day somebody reworded the message.
 */
function Trouble({
  id,
  error,
  fallback,
}: {
  readonly id: string
  readonly error: { readonly reason: string } | null
  readonly fallback: string
}) {
  if (error === null) return null

  return (
    <p id={id} className="said said-bad" role="alert">
      <ExclamationCircleFill aria-hidden />
      {saidFor(reasonOf(error), fallback)}
    </p>
  )
}

function useAnswerMachine(code: string, spaceSlug: string | undefined) {
  return useMutation<boolean, { reason: string }, AnswerDecision>({
    mutationFn: async (decision: AnswerDecision) => {
      if (decision.kind === 'approve') {
        const body = {
          userCode: code,
          ...(decision.replaceMachineId === undefined
            ? {}
            : { replaceMachineId: decision.replaceMachineId }),
          ...(spaceSlug === undefined ? {} : { spaceSlug }),
        }
        const { error, response } = await api.POST('/me/machines', { body })
        // No reason to read means the server did not answer in the shape it promises — a crash,
        // proxy or gateway. That is not the same as a machine that is no longer available.
        if (!response.ok) throw error
        return true
      }

      const { error, response } = await api.POST('/enrolments/{userCode}/refuse', {
        params: { path: { userCode: code } },
      })
      if (!response.ok) throw error
      return false
    },
  })
}

function CodeEntry({
  id,
  code,
  waitingError,
  answerError,
  onChange,
}: {
  readonly id: string
  readonly code: string
  readonly waitingError: string | undefined
  readonly answerError: string | undefined
  readonly onChange: (code: string) => void
}) {
  const errors = [waitingError, answerError].filter((error) => error !== undefined)
  const describedBy = errors.length === 0 ? undefined : errors.join(' ')

  return (
    <>
      <div className="connect-code">
        <label className="label" htmlFor={id}>
          Code
        </label>
        <input
          id={id}
          className="field connect-code-field"
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="WDJB-MJHT"
          value={code}
          aria-invalid={errors.length > 0}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
      </div>
      <button
        className="button button-primary connect-submit"
        type="submit"
        disabled={code.trim() === ''}
      >
        <span className="button-label">Find it</span>
      </button>
    </>
  )
}

function sameCode(left: string, right: string): boolean {
  return left.trim().toUpperCase() === right.trim().toUpperCase()
}

function ConnectionInstructions() {
  return (
    <>
      <header className="connect-head">
        <Mark size={42} />
        <h1>Connect a machine</h1>
        <p className="lede">Run this on the machine you want to connect.</p>
      </header>
      <ShellCommand command="handover connect" />
      <p className="note m-0">Then enter the code it shows.</p>
    </>
  )
}

type Me = components['schemas']['Me']
type WaitingMachine = components['schemas']['MachineWaiting']

function FoundAnswer({
  machine,
  isCurrent,
  me,
  spaceSlug,
  pending,
  onAnswer,
}: {
  readonly machine: WaitingMachine | undefined
  readonly isCurrent: boolean
  readonly me: Me | undefined
  readonly spaceSlug: string | undefined
  readonly pending: boolean
  readonly onAnswer: (decision: AnswerDecision) => void
}) {
  if (machine === undefined || !isCurrent || me === undefined) return null

  const space = me.spaces.find((candidate) => candidate.slug === spaceSlug)
  if (spaceSlug !== undefined && space === undefined) {
    return (
      <p className="said said-bad" role="alert">
        <ExclamationCircleFill aria-hidden />
        That Space is not available.
      </p>
    )
  }

  return (
    <Answer
      machineName={machine.machineName}
      existingMachines={machine.existingMachines}
      who={me.displayName}
      spaceName={space?.displayName}
      pending={pending}
      onAnswer={onAnswer}
    />
  )
}

type ConnectProps = { readonly typed: string; readonly spaceSlug?: string | undefined }

export function Connect({ typed, spaceSlug }: ConnectProps) {
  const field = useId()
  const waitingError = useId()
  const answerError = useId()
  const [code, setCode] = useState(typed)
  const [asked, setAsked] = useState(typed)

  const waiting = useQuery(waitingFor(asked))
  const me = useQuery(meQuery)
  const answer = useAnswerMachine(asked, spaceSlug)

  if (answer.isSuccess) return <Answered letIn={answer.data} />

  return (
    <main className="connect-page">
      <form
        className="step-card connect-card"
        onSubmit={(event) => {
          event.preventDefault()
          setAsked(code.trim())
        }}
      >
        <ConnectionInstructions />

        <Trouble
          id={waitingError}
          error={waiting.error}
          fallback="That could not be checked. Try again shortly."
        />
        <Trouble
          id={answerError}
          error={answer.error}
          fallback="That could not be done. Try again shortly."
        />

        <CodeEntry
          id={field}
          code={code}
          waitingError={waiting.isError ? waitingError : undefined}
          answerError={answer.isError ? answerError : undefined}
          onChange={setCode}
        />

        <FoundAnswer
          machine={waiting.data}
          isCurrent={sameCode(code, asked)}
          me={me.data}
          spaceSlug={spaceSlug}
          pending={answer.isPending}
          onAnswer={(decision) => {
            answer.mutate(decision)
          }}
        />
      </form>
    </main>
  )
}
