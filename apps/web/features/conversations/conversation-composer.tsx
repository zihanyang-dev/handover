import { useState } from 'react'
import {
  Composer,
  ComposerError,
  SendButton,
  StopButton,
} from '../../components/ui/chat-composer.tsx'
import { AgentMark, agentTint } from '../machines/agent.tsx'
import { useSay, useStop, type Message } from './conversation.ts'
import { askedWithChoices, ModelChoices, type Model } from './model-choices.tsx'
import { useSayingYouAreTyping } from './watching.ts'

export type PendingUserMessage = Extract<Message, { readonly role: 'user' }>

/** The composer as this screen wires it: what is said goes into the conversation it is under. */
export function ConversationComposer({
  slug,
  id,
  offers,
  agentKind,
  agentName,
  avatarSrc,
  working,
  turn,
  afterSeq,
  onPending,
}: {
  readonly slug: string
  readonly id: string
  readonly offers: readonly Model[]
  readonly agentKind: string
  readonly agentName: string
  readonly avatarSrc: string
  readonly working: boolean
  readonly turn: number
  readonly afterSeq: number
  readonly onPending: (message: PendingUserMessage | undefined) => void
}) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const say = useSay(slug, id)
  const stop = useStop(slug, id)
  const sayTyping = useSayingYouAreTyping(slug, id)

  return (
    <Composer
      label={`Message ${agentName}`}
      placeholder={`Ask ${agentName} anything…`}
      text={text}
      onText={(next) => {
        setText(next)
        if (next.trim() !== '') sayTyping()
      }}
      disabled={say.isPending}
      leading={<ComposerAvatar avatarSrc={avatarSrc} agentKind={agentKind} />}
      action={
        working ? (
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
        )
      }
      onSend={() => {
        if (working) return
        const sentText = text.trim()
        const asked = askedWithChoices(sentText, model, effort)
        onPending({
          role: 'user',
          seq: afterSeq + 1,
          at: new Date().toISOString(),
          said: null,
          content: asked,
        })
        setText('')
        say.mutate(asked, {
          onSuccess: () => {
            onPending(undefined)
          },
          onError: () => {
            onPending(undefined)
            setText(sentText)
          },
        })
      }}
    >
      {say.isError && <ComposerError>{whyNot(say.error.reason)}</ComposerError>}
      {stop.isError && <ComposerError>Could not stop it. Try again.</ComposerError>}
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
    </Composer>
  )
}

function whyNot(reason: string): string {
  if (reason === 'agent-not-on-machine') return 'This agent is no longer installed.'
  if (reason === 'unavailable') return 'This chat is not here any more.'

  return 'Could not send that. Try again.'
}

function ComposerAvatar({
  avatarSrc,
  agentKind,
}: {
  readonly avatarSrc: string
  readonly agentKind: string
}) {
  return (
    <span className="chat-composer-avatar" aria-hidden>
      {avatarSrc !== '' && <img src={avatarSrc} alt="" />}
      <span className={`chat-composer-avatar-mark ${agentTint(agentKind)}`}>
        <AgentMark kind={agentKind} />
      </span>
    </span>
  )
}
