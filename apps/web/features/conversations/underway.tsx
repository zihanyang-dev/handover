/**
 * The piece of work underway in a conversation, beside the conversation itself.
 *
 * Everything here is what somebody comes back to look for: what it is for, where it has got to,
 * what it handed out, what it has written. None of it can live in the transcript — a piece of
 * work somebody handed over runs for hours, and by morning the line that mattered is two hundred
 * lines up.
 *
 * It appears when a conversation is handed over and not before. Its being there *is* how a page
 * says "you walked away from this one".
 */

import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTakeBack, type Message, type Underway as What } from './talking.ts'

/** What each state is called, in the words a person reads. */
const STATES: Record<string, string> = {
  working: 'Working',
  wait: 'Waiting on you',
  sleep: 'Asleep',
  done: 'Finished',
}

export function Underway({
  slug,
  id,
  underway,
  messages,
}: {
  readonly slug: string
  readonly id: string
  readonly underway: What
  readonly messages: readonly Message[]
}) {
  const open = underway.handedOff.filter((one) => one.state !== 'done')

  return (
    <aside className="rail" aria-label="This piece of work">
      <div className="panel">
        <p className="rail-goal">{underway.goal}</p>
        <p className="note">{whereItIs(underway, open.length)}</p>
        <TakeBack slug={slug} id={id} />
      </div>

      <div className="panel">
        <h3>What has happened</h3>
        <Beats messages={messages} />
      </div>

      {underway.handedOff.length > 0 && (
        <div className="panel">
          <h3>It handed out</h3>
          <ul className="rows">
            {underway.handedOff.map((one) => (
              <li key={one.conversationId} className="row">
                <span className="row-name">
                  <Link to="/s/$slug/c/$id" params={{ slug, id: one.conversationId }}>
                    {one.goal}
                  </Link>
                  <span className="row-where">{one.machineName}</span>
                </span>
                <span className="chip">{STATES[one.state] ?? one.state}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {underway.outputs.length > 0 && (
        <div className="panel">
          <h3>It wrote</h3>
          <ul className="rows">
            {underway.outputs.map((one) => (
              <Written key={one.title} title={one.title} body={one.body} />
            ))}
          </ul>
        </div>
      )}

      {underway.under !== null && (
        <p className="note">
          Part of{' '}
          <Link to="/s/$slug/c/$id" params={{ slug, id: underway.under.conversationId }}>
            {underway.under.goal}
          </Link>
        </p>
      )}
    </aside>
  )
}

/**
 * Where it has got to, in one line.
 *
 * More states than the four it is kept in, and that is the point: what it is waiting on when it
 * handed work out is not a state of its own, it is the count of what is still open. Storing that
 * would be storing something two tables already say.
 */
function whereItIs(underway: What, open: number): string {
  if (underway.state === 'wait') return 'Waiting on you'
  if (underway.state === 'done') return 'Finished'
  if (underway.state === 'sleep') return `Asleep until ${when(underway.sleepUntil)}`
  if (open > 0) return `Waiting on ${String(open)} it handed out`

  return 'Working'
}

function when(at: string | null): string {
  return at === null ? 'later' : new Date(at).toLocaleString()
}

function TakeBack({ slug, id }: { readonly slug: string; readonly id: string }) {
  const back = useTakeBack(slug, id)

  return (
    <button
      className="button button-quiet"
      type="button"
      disabled={back.isPending}
      onClick={() => {
        back.mutate()
      }}
    >
      {/* What it does, said before it is pressed: whatever it handed out stops as well. */}
      <span className="button-label">Take it back</span>
    </button>
  )
}

/**
 * The lines of the transcript that are worth coming back to. Everything else is detail.
 *
 * An activity carries whatever the thing that wrote it put there, so nothing here trusts a field
 * to be the shape it looks like: a build that met one written by a newer build must show the line
 * it does understand rather than `[object Object]` in the middle of it.
 */
const WORTH_IT: Record<string, (what: Record<string, unknown>) => string> = {
  'handed-over': () => 'You handed it over',
  'handed-off': (what) => `Handed out: ${words(what['text'])}`,
  'handed-back': (what) => `Came back: ${words(what['text'])}`,
  asked: () => 'It asked you something',
  asleep: (what) => `Went to sleep until ${when(words(what['until']) || null)}`,
  finished: (what) => (what['ending'] === 'done' ? 'It finished' : 'It said it could not'),
  'taken-back': () => 'You took it back',
}

/** A field that ought to be words. Anything else has nothing worth showing in it. */
function words(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Which of them a person did, so the two are told apart at a glance rather than by reading. */
const YOURS = new Set(['handed-over', 'taken-back'])

/**
 * What has happened, read out of the transcript rather than kept anywhere.
 *
 * These are moments — what happened and when — and every one of them was already written by the
 * command the agent was running anyway. Nothing here asks it for a plan, and nothing here decides
 * anything: what is true *now* is the state beside it.
 */
function Beats({ messages }: { readonly messages: readonly Message[] }) {
  const beats = messages.flatMap((message) => {
    if (message.role !== 'activity') return []
    const say = WORTH_IT[message.content.activityType]

    return say === undefined
      ? []
      : [
          {
            seq: message.seq,
            at: message.at,
            said: say(message.content),
            who: message.content.activityType,
          },
        ]
  })

  if (beats.length === 0) return <p className="empty">Nothing yet.</p>

  return (
    <ul className="beats">
      {beats.map((beat) => (
        <li
          key={beat.seq}
          className={`beat ${YOURS.has(beat.who) ? 'beat-you' : ''} ${beat.who === 'finished' ? 'beat-over' : ''}`}
        >
          <span>{beat.said}</span>
          <time dateTime={beat.at}>{new Date(beat.at).toLocaleTimeString()}</time>
        </li>
      ))}
    </ul>
  )
}

/** One thing it wrote, opened where it is rather than on a page of its own. */
function Written({ title, body }: { readonly title: string; readonly body: string }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="row" style={{ display: 'block' }}>
      <button
        className="button button-quiet"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="button-label">{title}</span>
      </button>
      {open && <pre className="output">{body}</pre>}
    </li>
  )
}
