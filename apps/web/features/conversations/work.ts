/**
 * The piece of work a conversation carries once somebody walks away from it.
 *
 * Its own file rather than part of `talking.ts`, because it is a different fact about the same
 * conversation: talking is what was said, this is whether anybody still has to be there. A
 * conversation with nothing underway is the ordinary kind — you are sitting in it — and one with
 * something underway moves on its own between turns.
 *
 * What is underway is read as part of the transcript, so there is nothing to ask for here. This
 * file holds the three things a person does about a piece of work, and the words its state goes
 * by — two screens show a state and they were each writing the wire's own word onto the page.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, cached, retryKey, retryKeyDone } from '../../api.ts'
import { conversationsIn, inbox, transcriptOf } from './talking.ts'

/**
 * What a piece of work is doing, in words.
 *
 * The four states are the wire's, and `working` / `wait` / `sleep` / `done` are how the ledger
 * writes them down — not how a person reads them. An unfamiliar one is shown as itself, because
 * the column has no check constraint and a build that met a fifth should say so rather than call
 * it something it is not.
 */
export function whatItIsDoing(state: string): string {
  if (state === 'working') return 'Working'
  if (state === 'wait') return 'Waiting on somebody'
  if (state === 'sleep') return 'Sleeping'
  if (state === 'done') return 'Finished'

  return state
}

/** Everything that changes when a piece of work starts, stops, or moves. */
function useAfterwards(slug: string, id: string) {
  const client = useQueryClient()

  return async (): Promise<void> => {
    await Promise.all([
      client.invalidateQueries({ queryKey: transcriptOf(slug, id) }),
      client.invalidateQueries({ queryKey: conversationsIn(slug).queryKey }),
      // Handing something over is the only way anything ever arrives in an Inbox, and taking it
      // back is the only way something leaves one without being answered.
      client.invalidateQueries({ queryKey: inbox().queryKey }),
    ])
  }
}

/**
 * Handing it over, which is where a piece of work begins.
 *
 * The goal is the agent's own restatement, taken from the card it wrote — never from anything the
 * person typed. A sentence has the standing to be the name of a piece of work only because the
 * one that has to make it true wrote it, and the one who has to live with it read it.
 *
 * Its own mutation rather than the generated one, because the name it is made under is a decision
 * and not a parameter: named after that sentence, a lost answer can be handed over again without
 * starting a second piece of work, and pressing the card twice is one intention. A screen that
 * had to pass the name in is a screen that could pass a different one.
 */
export function useHandOver(slug: string, id: string) {
  const afterwards = useAfterwards(slug, id)

  return useMutation<void, { reason: string }, string>({
    mutationFn: async (goal: string) => {
      const intention = `hand-over:${id}:${goal}`
      const { error } = await api.POST('/spaces/{slug}/conversations/{id}/task', {
        params: { path: { slug, id } },
        body: { key: retryKey(intention), goal },
      })
      if (error !== undefined) throw error
      retryKeyDone(intention)
    },
    onSuccess: afterwards,
  })
}

/**
 * Taking it back, which also stops whatever it had handed off.
 *
 * One name for the whole of it, for the same reason: somebody who presses this twice while it
 * winds down means the same thing both times, and a fresh name each time would put a second
 * ending in the transcript.
 */
export function useTakeBack(slug: string, id: string) {
  const afterwards = useAfterwards(slug, id)

  return useMutation<void, { reason: string }>({
    mutationFn: async () => {
      const intention = `take-back:${id}`
      const { error } = await api.DELETE('/spaces/{slug}/conversations/{id}/task', {
        params: { path: { slug, id } },
        body: { key: retryKey(intention) },
      })
      if (error !== undefined) throw error
      retryKeyDone(intention)
    },
    onSuccess: afterwards,
  })
}

/**
 * Handing the piece of work to somebody else here.
 *
 * Only who is answerable changes: the conversation, its machine and everything said in it stay
 * exactly where they are. What moves is whose Inbox it stops in — which is why the Inbox is read
 * again, and why this is a Space's call rather than one under `/me`.
 */
export function useHandWorkTo(slug: string, id: string) {
  const afterwards = useAfterwards(slug, id)

  return cached.useMutation('patch', '/spaces/{slug}/conversations/{id}/task', {
    onSuccess: afterwards,
  })
}
