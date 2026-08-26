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
  useHandOver,
  useSay,
  useStop,
  useWatching,
  type Model,
  type Moment,
  type Message,
  type Working,
} from './talking.ts'
import { Underway } from './underway.tsx'

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
  'handed-over': 'You handed it over — from here it carries on by itself',
  'taken-back': 'You took it back',
  asked: 'It stopped to ask you something',
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

  const { agentKind, machineName, working, offers, messages, underway } = conversation.data

  return (
    <div className="alongside">
      <section className="panel">
        <div className="panel-head">
          <h2>{agentName(agentKind)}</h2>
          <span className="note">on {machineName}</span>
        </div>

        <ul className="stack">
          {inRuns(messages).map((run) =>
            run.kind === 'run' ? (
              <Run key={run.at} did={run.did} />
            ) : (
              <Said key={run.message.seq} message={run.message} slug={slug} id={id} />
            ),
          )}
        </ul>

        {/* Keyed by the turn: a new question is a new list, and nothing of the last one stays on
            screen. Nothing at all while it is idle — a settled turn has nothing to watch. */}
        {working.state === 'working' && <Watching key={turnOf(messages)} slug={slug} id={id} />}

        <Doing state={working.state} />
        <Ask
          slug={slug}
          id={id}
          working={working.state === 'working'}
          handedOver={underway !== undefined}
          turn={turnOf(messages)}
          offers={offers}
        />
      </section>

      {/* Only once somebody has handed it over. Its being here is how the page says so. */}
      {underway !== undefined && (
        <Underway slug={slug} id={id} underway={underway} messages={messages} />
      )}
    </div>
  )
}

/**
 * Where a line sits, so the beats beside the conversation can point at one.
 *
 * The sequence number and not an index: it is the same number the beat was read from, and it
 * survives anything arriving above it while somebody is reading.
 */
export function atSeq(seq: number): string {
  return `said-${String(seq)}`
}

/** How many tool calls in a row before they are worth folding away rather than read. */
const A_RUN = 3

type Piece =
  | { readonly kind: 'one'; readonly message: Message }
  | { readonly kind: 'run'; readonly at: number; readonly did: readonly Did[] }

/**
 * Runs of tool calls, folded into one line.
 *
 * A piece of work somebody walked away from leaves hundreds of these, and the two lines that
 * matter sit between them. Folding is not hiding: the run says how many and opens where it is.
 *
 * Only runs — a single tool call between two things said is part of reading the conversation, and
 * folding it would cost a click to learn nothing.
 */
function inRuns(messages: readonly Message[]): readonly Piece[] {
  const pieces: Piece[] = []
  let run: Message[] = []

  const settle = (): void => {
    if (run.length >= A_RUN) {
      pieces.push({
        kind: 'run',
        at: run[0]?.seq ?? 0,
        did: run.map((one) => one.content as Did),
      })
    } else {
      pieces.push(...run.map((message): Piece => ({ kind: 'one', message })))
    }
    run = []
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      run.push(message)
      continue
    }
    settle()
    pieces.push({ kind: 'one', message })
  }
  settle()

  return pieces
}

/** One fold. Shut it says how many; open it is the same lines it was always going to show. */
function Run({ did }: { readonly did: readonly Did[] }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="run">
      <button
        className="button button-quiet"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="button-label">
          {open ? 'Hide' : `${String(did.length)} things it did`}
        </span>
      </button>
      {open && (
        <ul className="stack">
          {did.map((one, index) => (
            <Used key={`${one.name}-${String(index)}`} did={one} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Which turn is running, by the question it is answering.
 *
 * The last thing a person said, because saying something is how a turn begins and interrupting is
 * how the next one does. It is what a stop is named after, and being able to name the turn is
 * what makes pressing Stop twice one request rather than two.
 */
function turnOf(messages: readonly Message[]): number {
  return messages.findLast((message) => message.role === 'user')?.seq ?? 0
}

function Said({
  message,
  slug,
  id,
}: {
  readonly message: Message
  readonly slug: string
  readonly id: string
}) {
  if (message.role === 'user')
    return (
      <li id={atSeq(message.seq)} className="said">
        {message.content.text}
      </li>
    )
  if (message.role === 'assistant')
    return (
      <li id={atSeq(message.seq)} className="said said-good">
        {message.content.text}
      </li>
    )
  if (message.role === 'tool') return <Used did={message.content} />
  if (message.content.activityType === 'proposed') {
    return <Proposal slug={slug} id={id} what={message.content} />
  }

  return <Happened at={message.seq} what={message.content} />
}

/**
 * A goal the agent put in front of you, and the moment you decide.
 *
 * It is a line in the transcript rather than something over the page, because that is what it is:
 * the agent said it, at that point in the conversation, and the answer belongs beside it.
 *
 * What you are agreeing to is not "may it start" but "did you understand me" — which is why the
 * sentence had to come from the agent, and why there is nothing here to fill in.
 */
function Proposal({
  slug,
  id,
  what,
}: {
  readonly slug: string
  readonly id: string
  readonly what: Activity
}) {
  const over = useHandOver(slug, id)
  const goal = textOf(what) ?? ''

  return (
    <li className="proposal">
      <p>{goal}</p>
      <div className="beside">
        {/* Both halves said here, because the other answer has no button and would otherwise look
            like no answer at all: nothing has started, and disagreeing is just carrying on. */}
        <span className="note">
          It will carry on by itself until it says otherwise. If that is not it, say so below —
          nothing has started.
        </span>
        <button
          className="button button-primary"
          type="button"
          disabled={over.isPending || goal === ''}
          onClick={() => {
            over.mutate(goal)
          }}
        >
          <span className="button-label">Hand it over</span>
        </button>
      </div>
      {over.isError && <p className="note">That did not go through. Try again.</p>}
    </li>
  )
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

function Happened({ at, what }: { readonly at: number; readonly what: Activity }) {
  // Nothing to say about a turn that simply ended. The next thing said is the end of it.
  if (what.activityType === 'done') return null

  const said = textOf(what) ?? ACTIVITIES[what.activityType] ?? what.activityType

  return (
    <li id={atSeq(at)} className="note">
      {said}
    </li>
  )
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

/** What it is up to, in a line. Stopping it is a button of its own — see {@link Ask}. */
function Doing({ state }: { readonly state: Working['state'] }) {
  if (state === 'unknown') {
    return <p className="note">Its machine is not here, so nobody can say what it is doing.</p>
  }

  return state === 'working' ? <p className="note">Working…</p> : null
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
 * What "hand it over" actually says to the agent.
 *
 * A sentence rather than a signal, because there is no signal — an agent is handed a question and
 * answers it, and this is a question. Asking for one sentence is asking for the thing a person
 * will read and agree to; asking for a plan would be asking for something nobody has decided how
 * to show yet.
 */
const ASK_IT_TO_TAKE_OVER = {
  text: `If I left you to carry this on by yourself, what would you be making true? Say it in one
sentence, and write it down with:

  handover task new "<that sentence>"

Do not start on it — I will read what you wrote and agree to it first.`,
}

/**
 * Saying something, and stopping it.
 *
 * One button, in one place, meaning one thing at a time: while it works that place says Stop, and
 * once it has stopped it says Send. Sending is never what ends a turn — somebody who types while
 * it is working may well be writing something to say *after* it finishes, and a Send that threw
 * away the last two seconds of a turn would make typing itself risky.
 *
 * The field is never disabled for being busy, though. Somebody typing "no, leave legacy/ alone"
 * is typing it *because* it is busy: the words come first, the stop is one press away.
 */
function Ask({
  slug,
  id,
  working,
  handedOver,
  turn,
  offers,
}: {
  readonly slug: string
  readonly id: string
  readonly working: boolean
  readonly handedOver: boolean
  readonly turn: number
  readonly offers: readonly Model[]
}) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const say = useSay(slug, id)
  const stop = useStop(slug, id)

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

      {/* The way in. An agent in an ordinary conversation has been told nothing about pieces of
          work — it answers questions — so somebody who types "take it from here" is talking to
          something that has never heard of that. This asks it in words it will act on, and what
          comes back is its own restatement, which is the only sentence with any standing to
          become the goal. */}
      {!working && !handedOver && (
        <button
          className="button button-secondary"
          type="button"
          disabled={say.isPending}
          onClick={() => {
            say.mutate(ASK_IT_TO_TAKE_OVER)
          }}
        >
          <span className="button-label">Hand it over…</span>
        </button>
      )}

      {working ? (
        <button
          className="button button-primary"
          type="button"
          disabled={stop.isPending}
          onClick={() => {
            stop.mutate(turn)
          }}
        >
          <span className="button-label">Stop</span>
        </button>
      ) : (
        <button className="button button-primary" type="submit" disabled={say.isPending}>
          <span className="button-label">Send</span>
        </button>
      )}
      {/* Said where it happened rather than as a banner: it is about the words still in the
          box, and somebody who has to go and pick another machine wants it beside them. */}
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
