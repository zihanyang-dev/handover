/**
 * Answering a machine that is asking to come in.
 *
 * Three things have to be true before saying yes means anything: this is the code that machine
 * showed, it is the machine somebody just ran a command on, and this is the Space they meant. The
 * screen asks all three, in that order, and never assumes the last one.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { CheckCircleFill, ExclamationCircleFill, Laptop } from 'react-bootstrap-icons'
import { api, cached, reasonOf } from '../../api.ts'
import { Mark } from '../../mark.tsx'
import { meQuery } from '../identity/me.ts'

const SAID: Record<string, string> = {
  'no-enrolment': 'Nothing is waiting under that code. Check the terminal, or run it again.',
  unavailable: 'That Space is not available.',
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
 * One question and one answer: is that your machine. Not "into which Space" — a machine belongs
 * to whoever connected it, and it is reachable from wherever they are a member. Asking which
 * Space would be asking somebody to decide something that follows from where they already are.
 */
function Answer({
  machineName,
  who,
  anySpace,
  pending,
  onAnswer,
}: {
  readonly machineName: string
  readonly who: string
  readonly anySpace: boolean
  readonly pending: boolean
  readonly onAnswer: (yes: boolean) => void
}) {
  return (
    <div className="connect-answer">
      <p className="said said-good" role="status">
        <Laptop aria-hidden />
        <strong>{machineName}</strong> is asking to come in. Is that the machine you just ran the
        command on?
      </p>

      <button
        className="button button-primary"
        type="button"
        disabled={pending}
        onClick={() => {
          onAnswer(true)
        }}
      >
        <span className="button-label">Yes, that is mine</span>
      </button>

      {/* Whose it will be, said before it is agreed to. Somebody signing in with a way in that
          turns out to have its own account would otherwise attach their laptop to an account
          they did not mean — and be sure they had, because on their other one they do. */}
      <p className="note">
        It will be yours, as <strong>{who}</strong>, and reachable from every Space you are in.
        {/* Said plainly rather than left to be discovered: connecting works, and then nothing can
            run on it, and the machine is not what is wrong. */}
        {!anySpace && ' You are not in one yet — make a Space and it will be there.'}
      </p>

      <button
        className="button h-7 min-h-7 rounded-[var(--interaction-radius)] border-0 bg-transparent px-2 py-0 text-copy-xs font-normal text-content shadow-none transition-colors duration-100 ease-in-out enabled:hover:bg-[var(--interaction-hover)] enabled:active:bg-[var(--interaction-pressed)] focus-visible:shadow-[0_0_0_2px_var(--base),0_0_0_4px_var(--focus)]"
        type="button"
        disabled={pending}
        onClick={() => {
          onAnswer(false)
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
      <section className="connect-card connect-result">
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
      {SAID[reasonOf(error) ?? ''] ?? fallback}
    </p>
  )
}

export function Connect({ typed }: { readonly typed: string }) {
  const field = useId()
  const waitingError = useId()
  const answerError = useId()
  const [code, setCode] = useState(typed)
  const [asked, setAsked] = useState(typed)

  const waiting = useQuery(waitingFor(asked))
  const me = useQuery(meQuery)

  const answer = useMutation<boolean, { reason: string }, boolean>({
    mutationFn: async (yes: boolean) => {
      const { error, response } = yes
        ? await api.POST('/me/machines', { body: { userCode: asked } })
        : await api.POST('/enrolments/{userCode}/refuse', {
            params: { path: { userCode: asked } },
          })
      // No reason to read means the server did not answer in the shape it promises — a crash, a
      // proxy, a gateway. Calling that "unavailable" would say the Space is gone, which is a
      // different thing and one somebody would go and look for.
      if (!response.ok) throw error
      return yes
    },
  })

  if (answer.isSuccess) return <Answered letIn={answer.data} />

  return (
    <main className="connect-page">
      <form
        className="connect-card"
        onSubmit={(event) => {
          event.preventDefault()
          setAsked(code.trim())
        }}
      >
        <header className="connect-head">
          <Mark size={42} />
          <h1>Connect a machine</h1>
          <p className="lede">Type the code shown in the terminal you ran the command in.</p>
        </header>

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

        <div className="connect-code">
          <label className="label" htmlFor={field}>
            Code
          </label>
          <input
            id={field}
            className="field connect-code-field"
            autoFocus
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="WDJB-MJHT"
            value={code}
            aria-invalid={waiting.isError || answer.isError}
            aria-describedby={
              [waiting.isError ? waitingError : '', answer.isError ? answerError : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(event) => {
              setCode(event.target.value)
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

        {/* Only while the box still says what was looked up. Editing it and pressing approve
            would let go of a machine somebody is no longer looking at: the screen says code B and
            the button answers for code A. */}
        {/* Not until it is known whose it would be: the answer says so, and saying the wrong
          name is how somebody attaches their laptop to an account they did not mean. */}
        {me.isSuccess &&
          waiting.data !== undefined &&
          code.trim().toUpperCase() === asked.trim().toUpperCase() && (
            <Answer
              machineName={waiting.data.machineName}
              who={me.data.displayName}
              anySpace={me.data.spaces.length > 0}
              pending={answer.isPending}
              onAnswer={(yes) => {
                answer.mutate(yes)
              }}
            />
          )}
      </form>
    </main>
  )
}
