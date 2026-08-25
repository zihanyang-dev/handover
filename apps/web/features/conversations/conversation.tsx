/**
 * One conversation, as it happened.
 *
 * Everything said is shown in the order it was said, including the parts that are not speech: a
 * tool it used, that somebody stopped it, that it does not remember what came before. Those are
 * what make a transcript an account of what happened rather than a chat log with gaps in it.
 */

import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckCircle, ExclamationCircle, Terminal } from 'react-bootstrap-icons'
import { agentName } from '../agents.ts'
import { useConversation, useSay, useStop } from './talking.ts'

type Message = { readonly seq: number; readonly role: string; readonly content?: unknown }

/**
 * What an activity says, for the ones this page has words for.
 *
 * Anything else is shown as itself rather than hidden. New kinds arrive as values, and a page that
 * silently dropped the ones it did not know would leave a conversation looking like it skipped.
 */
const ACTIVITIES: Record<string, string> = {
  cancelled: 'You stopped it',
  stop: 'You asked it to stop',
  forgot: 'It does not remember anything said before this',
  unknown: 'Nobody knows how this turn went — its machine was not there to say',
}

export function Conversation({ slug, id }: { readonly slug: string; readonly id: string }) {
  const conversation = useConversation(slug, id)

  if (conversation.isPending) return <p className="empty">Looking…</p>

  // Not there and not yours are one answer, so this page cannot tell them apart either.
  if (conversation.data === null || conversation.data === undefined) {
    return (
      <section className="panel">
        <h2>This conversation is not available</h2>
        <p className="note" style={{ marginTop: '0.5rem' }}>
          <Link to="/s/$slug" params={{ slug }}>
            Back to the Space
          </Link>
        </p>
      </section>
    )
  }

  const { agentKind, machineName, working, messages } = conversation.data

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{agentName(agentKind)}</h2>
        <span className="note">on {machineName}</span>
      </div>

      <ul className="stack">
        {messages.map((message) => (
          <Said key={message.seq} message={message} />
        ))}
      </ul>

      <Doing state={working.state} slug={slug} id={id} turn={turnOf(messages)} />
      <Ask slug={slug} id={id} busy={working.state === 'working'} />
    </section>
  )
}

/**
 * Which turn is running, by the question it is answering.
 *
 * A person cannot say anything while the agent is working, so the last thing they said names the
 * turn for as long as there is one to stop. It is what a stop is named after, and being able to
 * name the turn is what makes asking twice one request rather than two.
 */
function turnOf(messages: readonly Message[]): number {
  return messages.findLast((message) => message.role === 'user')?.seq ?? 0
}

function Said({ message }: { readonly message: Message }) {
  if (message.role === 'user') return <li className="said">{textOf(message.content)}</li>
  if (message.role === 'assistant')
    return <li className="said said-good">{textOf(message.content)}</li>
  if (message.role === 'tool') return <Used content={message.content} />

  return <Happened content={message.content} />
}

function Used({ content }: { readonly content: unknown }) {
  const [open, setOpen] = useState(false)
  const did = content as {
    name: string
    verb: string
    arg: string
    ok?: boolean
    excerpt: string
  }
  // A tool that never says how it went keeps that: a tick beside one nobody checked would be
  // this page inventing an answer.
  const mark =
    did.ok === undefined ? null : did.ok ? (
      <CheckCircle aria-hidden />
    ) : (
      <ExclamationCircle aria-hidden />
    )

  return (
    <li className="row">
      <span className="row-name">
        <Terminal aria-hidden />
        {/* Its own name when we have no word for it, so a tool nobody taught this page is still
            a thing somebody can see happened. */}
        <strong>{did.verb === '' ? did.name : did.verb}</strong>
        <span className="note">{did.arg}</span>
        {mark}
      </span>
      {did.excerpt !== '' && (
        <button
          className="button button-quiet"
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
          }}
        >
          <span className="button-label">{open ? 'Hide' : 'What came back'}</span>
        </button>
      )}
      {open && <pre className="code">{did.excerpt}</pre>}
    </li>
  )
}

function Happened({ content }: { readonly content: unknown }) {
  const what = content as { activityType: string; text?: string }

  // Nothing to say about a turn that simply ended. The next thing said is the end of it.
  if (what.activityType === 'done') return null

  const said = what.text ?? ACTIVITIES[what.activityType] ?? what.activityType

  return <li className="note">{said}</li>
}

function Doing({
  state,
  slug,
  id,
  turn,
}: {
  readonly state: string
  readonly slug: string
  readonly id: string
  readonly turn: number
}) {
  const stop = useStop(slug, id)

  if (state === 'unknown') {
    return <p className="note">Its machine is not here, so nobody can say what it is doing.</p>
  }

  if (state !== 'working') return null

  return (
    <div className="beside">
      <span className="note">Working…</span>
      <button
        className="button button-quiet"
        type="button"
        disabled={stop.isPending}
        onClick={() => {
          stop.mutate(turn)
        }}
      >
        <span className="button-label">Stop</span>
      </button>
    </div>
  )
}

function Ask({
  slug,
  id,
  busy,
}: {
  readonly slug: string
  readonly id: string
  readonly busy: boolean
}) {
  const [text, setText] = useState('')
  const say = useSay(slug, id)

  return (
    <form
      className="stack-tight"
      onSubmit={(event) => {
        event.preventDefault()
        if (text.trim() === '') return
        say.mutate(text, {
          onSuccess: () => {
            setText('')
          },
        })
      }}
    >
      <label className="label" htmlFor={`say-${id}`}>
        Say something
      </label>
      <textarea
        id={`say-${id}`}
        className="field"
        rows={3}
        value={text}
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value)
        }}
      />
      <button className="button button-primary" type="submit" disabled={busy || say.isPending}>
        <span className="button-label">Send</span>
      </button>
      {/* Said where it happened rather than as a banner: what to do next depends on which of
          these it was, and the two are not the same wait. */}
      {say.isError && <p className="note">{whyNot(say.error.message)}</p>}
    </form>
  )
}

function whyNot(reason: string): string {
  if (reason === 'still-answering') return 'It is still answering. Wait for it to finish.'
  if (reason === 'machine-away') return 'Its machine is not here. Wait for it, or use another one.'

  return 'That did not go through. Try again.'
}

function textOf(content: unknown): string {
  return (content as { text?: string } | null)?.text ?? ''
}
