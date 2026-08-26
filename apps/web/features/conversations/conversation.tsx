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
import {
  useConversation,
  useSay,
  useStop,
  useWatching,
  type Model,
  type Moment,
  type Message,
} from './talking.ts'

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

  // A read that failed is not a conversation that is gone. Folded together, somebody goes looking
  // for something that is still exactly where they left it.
  if (conversation.isError) {
    return (
      <section className="panel">
        <p className="empty">Could not read this conversation. Try again.</p>
      </section>
    )
  }

  // Not there and not yours are one answer, so this page cannot tell them apart either.
  if (conversation.data === null) {
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

  const { agentKind, machineName, working, offers, messages } = conversation.data

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

      {/* Keyed by the turn: a new question is a new list, and nothing of the last one stays on
          screen. Nothing at all while it is idle — a settled turn has nothing to watch. */}
      {working.state === 'working' && <Watching key={turnOf(messages)} slug={slug} id={id} />}

      <Doing state={working.state} slug={slug} id={id} turn={turnOf(messages)} />
      <Ask slug={slug} id={id} working={working.state === 'working'} offers={offers} />
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
  if (message.role === 'user') return <li className="said">{message.content.text}</li>
  if (message.role === 'assistant')
    return <li className="said said-good">{message.content.text}</li>
  if (message.role === 'tool') return <Used did={message.content} />

  return <Happened what={message.content} />
}

/** What a tool call holds is the contract's to say, and it says it — see `Message` there. */
type Did = Extract<Message, { role: 'tool' }>['content']
type Activity = Extract<Message, { role: 'activity' }>['content']

function Used({ did }: { readonly did: Did }) {
  const [open, setOpen] = useState(false)
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
      {open && <pre className="output">{did.excerpt}</pre>}
    </li>
  )
}

function Happened({ what }: { readonly what: Activity }) {
  // Nothing to say about a turn that simply ended. The next thing said is the end of it.
  if (what.activityType === 'done') return null

  const said = textOf(what) ?? ACTIVITIES[what.activityType] ?? what.activityType

  return <li className="note">{said}</li>
}

/**
 * What is happening right now, which is not what the transcript will keep.
 *
 * Said out loud rather than left to be discovered: the thinking on this list is gone once the turn
 * settles, and a person who came back looking for it would otherwise think something was lost.
 */
function Watching({ slug, id }: { readonly slug: string; readonly id: string }) {
  const moments = useWatching(slug, id)
  if (moments.length === 0) return null

  return (
    <ul className="stack-tight" aria-label="Happening now">
      {moments.map((moment, at) => (
        // Nothing here has a name of its own: it is a stream, and its place in it is what it is.
        // Nothing is ever removed or reordered, so the index is stable while it matters.
        <li key={at} className="note">
          {said(moment)}
        </li>
      ))}
      <li className="note">Thinking is shown here and never kept.</li>
    </ul>
  )
}

/**
 * One live moment, in a line. Two kinds, and both of them are gone as soon as they are over.
 *
 * Thinking with nothing in it is still worth a line: Claude Code's own record keeps a signature
 * and no readable text, so "it is thinking" is all there is to say and all anybody needs.
 */
function said(moment: Moment): string {
  if (moment.said === 'thinking') {
    return moment.text.trim() === '' ? 'Thinking…' : `Thinking — ${moment.text}`
  }

  return `${moment.verb === '' ? moment.name : moment.verb} ${moment.arg}`.trim()
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

/**
 * The model a question is asked with, and how hard to think about it.
 *
 * Per question, not per conversation: the cheap one and the hard one turn up in the same
 * conversation, and being made to choose once at the start would be choosing for both.
 *
 * Nothing chosen sends nothing, which leaves the agent on its own default. We never pick one on
 * its behalf — a default we invented would be a choice nobody made, attributed to the agent.
 */
function Choices({
  offers,
  model,
  effort,
  onModel,
  onEffort,
}: {
  readonly offers: readonly Model[]
  readonly model: string
  readonly effort: string
  readonly onModel: (id: string) => void
  readonly onEffort: (level: string) => void
}) {
  // An agent that offers nothing gets no control at all. Picking an agent is picking what it can
  // do, and an empty select would be a question with no answers.
  if (offers.length === 0) return null

  // The one the agent uses when nobody says, which is what choosing nothing means. It is not
  // listed a second time: Claude Code publishes its default as a row of its own, and an "its
  // default" option beside a row called "Default" is two ways to say one thing.
  const itsOwn = offers.find((one) => one.isDefault)
  const rest = offers.filter((one) => !one.isDefault)

  // What the effort levels belong to: the model chosen, or the one it would use anyway.
  const chosen = offers.find((one) => one.id === model) ?? itsOwn
  const efforts = chosen?.efforts ?? []

  return (
    <div className="beside">
      <select
        className="field"
        aria-label="Model"
        value={model}
        onChange={(event) => {
          onModel(event.target.value)
        }}
      >
        {/* Empty, because choosing it sends nothing at all — the agent is left on its own
            default rather than pinned to whatever that happens to be named today. */}
        <option value="" title={itsOwn?.about}>
          {itsOwn?.name ?? 'Its default'}
        </option>
        {rest.map((one) => (
          <option key={one.id} value={one.id} title={one.about}>
            {one.name}
          </option>
        ))}
      </select>

      {efforts.length > 0 && (
        <select
          className="field"
          aria-label="Thinking"
          value={effort}
          onChange={(event) => {
            onEffort(event.target.value)
          }}
        >
          <option value="">Its default</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/**
 * Saying something, which interrupts it if it is in the middle of something.
 *
 * Nothing here is ever disabled for being busy. Somebody typing "no, leave legacy/ alone" is
 * saying it *because* it is busy, and a field that greys itself out at that moment is the one
 * moment it had a job to do.
 */
function Ask({
  slug,
  id,
  working,
  offers,
}: {
  readonly slug: string
  readonly id: string
  readonly working: boolean
  readonly offers: readonly Model[]
}) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const say = useSay(slug, id)

  return (
    <form
      className="stack-tight"
      onSubmit={(event) => {
        event.preventDefault()
        if (text.trim() === '') return
        say.mutate(
          {
            text,
            // Absent, not empty: an empty string is a choice of nothing, and what is meant here
            // is that no choice was made.
            ...(model === '' ? {} : { model }),
            ...(effort === '' ? {} : { effort }),
          },
          {
            onSuccess: () => {
              // The words go, the choices stay. Somebody who moved to the hard model is usually
              // still on the hard problem.
              setText('')
            },
          },
        )
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
        onChange={(event) => {
          setText(event.target.value)
        }}
      />

      <Choices
        offers={offers}
        model={model}
        effort={effort}
        onModel={(id_) => {
          setModel(id_)
          // An effort the new model does not have is not a choice, it is a leftover.
          setEffort('')
        }}
        onEffort={setEffort}
      />

      <button className="button button-primary" type="submit" disabled={say.isPending}>
        {/* What pressing it means, said before it is pressed: it stops what it is doing. */}
        <span className="button-label">{working ? 'Interrupt and send' : 'Send'}</span>
      </button>
      {/* Said where it happened rather than as a banner: what to do next depends on which of
          these it was, and the two are not the same wait. */}
      {say.isError && <p className="note">{whyNot(say.error.message)}</p>}
    </form>
  )
}

function whyNot(reason: string): string {
  if (reason === 'machine-away') return 'Its machine is not here. Wait for it, or use another one.'

  return 'That did not go through. Try again.'
}

/**
 * The words an activity carries, when it carries any.
 *
 * Open by design — a new kind of activity is a value, not a release — so this is the one place
 * left that has to look before it reads. A failure says what went wrong in its own words; the
 * rest are named by their type alone.
 */
function textOf(what: Activity): string | undefined {
  const said: unknown = what['text']
  return typeof said === 'string' && said !== '' ? said : undefined
}
