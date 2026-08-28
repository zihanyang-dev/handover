/**
 * One conversation, read and spoken into.
 *
 * Two things are on screen at once and only one of them survives: the transcript, which is
 * everything that was written down, and the live line under it, which is what is happening this
 * moment and is kept nowhere. They come from different places on purpose — see `talking.ts`.
 */

import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { SendButton, StopButton } from './composer-buttons.tsx'
import { askedWithChoices, ModelChoices, type Model } from './model-choices.tsx'
import {
  useConversation,
  useSay,
  useStop,
  useWatching,
  type Message,
  type Moment,
  type Working,
} from './talking.ts'

export function Chat({ slug, id }: { readonly slug: string; readonly id: string }) {
  const conversation = useConversation(slug, id)

  if (conversation.isPending) return <p className="chat-screen-state">Looking…</p>
  if (conversation.isError)
    return <p className="chat-screen-state">Could not read this chat. Try again.</p>
  if (conversation.data === null) {
    return (
      <div className="chat-screen-state">
        <p>This chat is not available.</p>
        <Link to="/s/$slug" params={{ slug }}>
          Back to the Space
        </Link>
      </div>
    )
  }

  const { agentKind, messages, offers, working } = conversation.data
  return (
    <section className="chat-screen" aria-label="Chat">
      <ol className="chat-transcript">
        {messages.map((message) => (
          <Line key={message.seq} message={message} />
        ))}
      </ol>
      <Live slug={slug} id={id} turn={turnOf(messages)} show={working.state === 'working'} />
      <WorkingState working={working} />
      <Composer
        slug={slug}
        id={id}
        offers={offers}
        agentKind={agentKind}
        working={working.state === 'working'}
        turn={turnOf(messages)}
      />
    </section>
  )
}

function Line({ message }: { readonly message: Message }) {
  if (message.role === 'user')
    return <li className="chat-line chat-line-person">{message.content.text}</li>
  if (message.role === 'assistant')
    return <li className="chat-line chat-line-agent">{message.content.text}</li>
  if (message.role === 'tool') {
    return (
      <li className="chat-line chat-line-tool">
        <strong>{message.content.verb || message.content.name}</strong>
        <span>{message.content.arg}</span>
        {message.content.excerpt !== '' && <pre>{message.content.excerpt}</pre>}
      </li>
    )
  }

  const happened = activityText(message)
  return happened === null ? null : <li className="chat-line chat-line-activity">{happened}</li>
}

/**
 * What is happening right now, which is kept nowhere and shown only while it happens.
 *
 * The turn is passed in rather than made into a key on this component. Keyed, a new turn would
 * unmount this and close the stream at the very moment that turn's first moments arrive — they
 * are sent once, so each one that landed in the gap was gone, and a turn appeared to begin in
 * silence. The list is cleared inside instead, and the connection is never touched.
 */
function Live({
  slug,
  id,
  turn,
  show,
}: {
  readonly slug: string
  readonly id: string
  readonly turn: number
  readonly show: boolean
}) {
  const moments = useWatching(slug, id, turn)
  if (!show || moments.length === 0) return null

  return (
    <ul className="chat-live" aria-label="Happening now">
      {moments.map((moment, index) => (
        <li key={index}>{momentText(moment)}</li>
      ))}
      <li>Thinking and full output are shown now and are not kept.</li>
    </ul>
  )
}

function Composer({
  slug,
  id,
  offers,
  agentKind,
  working,
  turn,
}: {
  readonly slug: string
  readonly id: string
  readonly offers: readonly Model[]
  readonly agentKind: string
  readonly working: boolean
  readonly turn: number
}) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const say = useSay(slug, id)
  const stop = useStop(slug, id)

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault()
        const asked = text.trim()
        if (asked === '' || working) return
        say.mutate(askedWithChoices(asked, model, effort), {
          onSuccess: () => {
            setText('')
          },
        })
      }}
    >
      <textarea
        aria-label="Message agent"
        placeholder="Say something…"
        rows={3}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
      />
      <div className="chat-composer-actions">
        {say.isError && (
          <span className="composer-error" role="alert">
            {whyNot(say.error.message)}
          </span>
        )}
        {stop.isError && (
          <span className="composer-error" role="alert">
            Could not stop it. Try again.
          </span>
        )}
        <ModelChoices
          offers={offers}
          agentKind={agentKind}
          model={model}
          effort={effort}
          onModel={(next) => {
            setModel(next)
            setEffort('')
          }}
          onEffort={setEffort}
        />
        {working ? (
          <StopButton
            disabled={stop.isPending}
            onStop={() => {
              stop.mutate({
                params: { path: { slug, id } },
                body: { key: `${String(turn)}/stop` },
              })
            }}
          />
        ) : (
          <SendButton disabled={say.isPending || text.trim() === ''} />
        )}
      </div>
    </form>
  )
}

function WorkingState({ working }: { readonly working: Working }) {
  if (working.state === 'working')
    return (
      <p className="chat-working" role="status" aria-live="polite">
        Working…
      </p>
    )
  if (working.state === 'unknown')
    return (
      <p className="chat-working" role="status" aria-live="polite">
        Nobody knows how that turn ended.
      </p>
    )
  return null
}

function turnOf(messages: readonly Message[]): number {
  let latest = 0
  for (const message of messages) {
    if (message.role === 'user') latest = message.seq
  }
  return latest
}

function momentText(moment: Moment): string {
  if (moment.said === 'thinking') return moment.text
  if (moment.said === 'output') return moment.text
  return `${moment.verb} ${moment.arg}`.trim()
}

/**
 * What an activity says, for the ones this screen has words for.
 *
 * `done` alone shows nothing: a turn that simply ended says so by the next thing being said.
 * Everything else is shown — anything without words here appears as its own name rather than
 * disappearing. A transcript is an account of what happened, and a page that quietly dropped the
 * kinds it had not heard of would leave one looking like it skipped.
 */
const ACTIVITY_TEXT = new Map<string, string>([
  ['cancelled', 'Stopped'],
  ['failed', 'That turn failed'],
  ['unknown', 'Nobody knows how that turn ended'],
  ['forgot', 'This agent could not remember the earlier chat'],
  ['stop', 'You asked it to stop'],
  ['unreadable', 'One event could not be read'],
])

function activityText(what: Message & { role: 'activity' }): string | null {
  if (what.content.activityType === 'done') return null
  const said: unknown = what.content['text']

  return (
    (typeof said === 'string' && said !== '' ? said : undefined) ??
    ACTIVITY_TEXT.get(what.content.activityType) ??
    what.content.activityType
  )
}

/**
 * Why what was said did not land.
 *
 * A machine that is not here is deliberately not among these: words said into a conversation that
 * already exists are written down whether or not its laptop is open, and the turn carries them
 * when it asks again. Only opening one can be refused for that — see `start-chat.tsx`.
 */
function whyNot(reason: string): string {
  if (reason === 'agent-not-on-machine') return 'This agent is no longer installed.'
  if (reason === 'unavailable') return 'This conversation is not here any more.'

  return 'Could not send that. Try again.'
}
