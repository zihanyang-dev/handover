/**
 * Answering a machine that is asking to come in.
 *
 * Three things have to be true before saying yes means anything: this is the code that machine
 * showed, it is the machine somebody just ran a command on, and this is the Space they meant. The
 * screen asks all three, in that order, and never assumes the last one.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { CheckCircleFill, ExclamationCircleFill, Laptop } from 'react-bootstrap-icons'
import { api } from '../../api.ts'
import { meQuery } from '../identity/me.ts'

const SAID: Record<string, string> = {
  'no-enrolment': 'Nothing is waiting under that code. Check the terminal, or run it again.',
  unavailable: 'That Space is not available.',
}

function waitingFor(code: string) {
  return {
    queryKey: ['enrolment', code] as const,
    enabled: code !== '',
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.GET('/enrolments/{userCode}', {
        params: { path: { userCode: code } },
      })
      if (data === undefined) throw new Error(error.reason)
      return data
    },
  }
}

/**
 * The half that is answered, once there is something to answer about.
 *
 * Which Space is asked, never assumed: the machine does not name one — it has no standing to
 * choose — so this is the only place the question gets put.
 */
function Answer({
  machineName,
  who,
  spaces,
  pending,
  onAnswer,
}: {
  readonly machineName: string
  readonly who: string
  readonly spaces: readonly { id: string; slug: string; displayName: string }[]
  readonly pending: boolean
  readonly onAnswer: (slug: string, yes: boolean) => void
}) {
  return (
    <div className="stack-tight">
      <p className="said said-good" role="status">
        <Laptop aria-hidden />
        <strong>{machineName}</strong> is asking to come in. Is that the machine you just ran the
        command on?
      </p>

      <p className="label">Let it into</p>
      {spaces.length === 0 ? (
        // Not a Space that went missing — a person who is in none. Arriving here that way is
        // ordinary: signing in with a way in that turns out to have its own account is exactly
        // how somebody lands with nothing to approve into, and they will be sure they have a
        // Space, because on their other account they do. So the account is named. Without the
        // name this reads as a broken screen, and the next thing tried is the button that turns
        // your own machine away.
        <p className="empty">
          Signed in as <strong>{who}</strong>, who is not in any Space yet.{' '}
          <Link to="/">Make one</Link>, then come back to this code.
        </p>
      ) : (
        spaces.map((space) => (
          <button
            key={space.id}
            className="button button-primary"
            type="button"
            disabled={pending}
            onClick={() => {
              onAnswer(space.slug, true)
            }}
          >
            <span className="button-label">{space.displayName}</span>
          </button>
        ))
      )}

      <button
        className="button button-quiet"
        type="button"
        disabled={pending}
        onClick={() => {
          onAnswer('', false)
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
    <main className="sheet">
      <section className="card stack">
        <p className="said said-good" role="status">
          <CheckCircleFill aria-hidden />
          {letIn ? 'That machine is in. Its terminal will say so.' : 'Turned away.'}
        </p>
      </section>
    </main>
  )
}

/** Something did not work. Words where there are words for it, and never the word off the wire. */
function Trouble({ error, fallback }: { readonly error: Error | null; readonly fallback: string }) {
  if (error === null) return null

  return (
    <p className="said said-bad" role="alert">
      <ExclamationCircleFill aria-hidden />
      {SAID[error.message] ?? fallback}
    </p>
  )
}

export function Connect({ typed }: { readonly typed: string }) {
  const field = useId()
  const [code, setCode] = useState(typed)
  const [asked, setAsked] = useState(typed)

  const waiting = useQuery(waitingFor(asked))
  const me = useQuery(meQuery)
  const spaces = me.data?.spaces ?? []

  const answer = useMutation({
    mutationFn: async (into: { slug: string; yes: boolean }) => {
      const path = { slug: into.slug, userCode: asked }
      const { error, response } = into.yes
        ? await api.POST('/spaces/{slug}/enrolments/{userCode}/approve', { params: { path } })
        : await api.POST('/enrolments/{userCode}/refuse', {
            params: { path: { userCode: asked } },
          })
      // No reason to read means the server did not answer in the shape it promises — a crash, a
      // proxy, a gateway. Calling that "unavailable" would say the Space is gone, which is a
      // different thing and one somebody would go and look for.
      if (!response.ok) throw new Error(error?.reason ?? 'unknown')
      return into.yes
    },
  })

  if (answer.isSuccess) return <Answered letIn={answer.data} />

  return (
    <main className="sheet">
      <form
        className="card stack"
        onSubmit={(event) => {
          event.preventDefault()
          setAsked(code.trim())
        }}
      >
        <div className="stack-tight">
          <h1>Connect a machine</h1>
          <p className="lede">Type the code shown in the terminal you ran the command in.</p>
        </div>

        <Trouble error={waiting.error} fallback="That could not be checked. Try again shortly." />
        <Trouble error={answer.error} fallback="That could not be done. Try again shortly." />

        <div className="stack-tight">
          <label className="label" htmlFor={field}>
            Code
          </label>
          <div className="beside">
            <input
              id={field}
              className="field"
              autoFocus
              placeholder="WDJB-MJHT"
              value={code}
              onChange={(event) => {
                setCode(event.target.value)
              }}
            />
            <button className="button button-secondary" type="submit" disabled={code.trim() === ''}>
              <span className="button-label">Find it</span>
            </button>
          </div>
        </div>

        {/* Only while the box still says what was looked up. Editing it and pressing approve
            would let go of a machine somebody is no longer looking at: the screen says code B and
            the button answers for code A. */}
        {waiting.data !== undefined && code.trim().toUpperCase() === asked.trim().toUpperCase() && (
          <Answer
            machineName={waiting.data.machineName}
            who={me.data?.displayName ?? ''}
            spaces={spaces}
            pending={answer.isPending}
            onAnswer={(slug, yes) => {
              answer.mutate({ slug, yes })
            }}
          />
        )}
      </form>
    </main>
  )
}
