/**
 * Asking to come in, and waiting for somebody to say yes.
 *
 * The waiting is a plain loop against one endpoint. There is no callback and no local port, so it
 * works the same on a laptop and on a server nobody can reach — which is the whole reason the
 * approving happens on whatever device the person has to hand.
 */

import { answered, type Api } from './api.ts'
import type { Attachment } from './store.ts'

export type Asked = {
  readonly secret: string
  readonly userCode: string
  readonly verifyUrl: string
  readonly verifyUrlComplete: string
  readonly expiresAt: string
}

export type Connected =
  | {
      readonly kind: 'connected'
      readonly attachment: Attachment
      readonly lookFor: readonly string[]
    }
  /** Somebody said no, it ran out, or somebody else took the key. Each ends the attempt. */
  | { readonly kind: 'gave-up'; readonly why: string }

export type Waiting = {
  /** Called once, with what to show. Printing is the caller's job, not this loop's. */
  readonly show: (asked: Asked) => void
  readonly sleep: (seconds: number) => Promise<void>
}

export async function askToConnect(api: Api, machineName: string): Promise<Asked> {
  const { data, error } = await api.POST('/enrolments', { body: { machineName } })
  if (data === undefined) throw new Error(error.reason)

  return data
}

/**
 * Keeps asking until it is let in or turned away.
 *
 * Waiting is not an error and does not end anything: it is what the answer says most of the time,
 * and the loop exists to sit through it.
 */
export async function waitToBeLetIn(
  api: Api,
  origin: string,
  asked: Asked,
  waiting: Waiting,
): Promise<Connected> {
  waiting.show(asked)

  for (;;) {
    const came = await answered(api.POST('/enrolments/collect', { body: { secret: asked.secret } }))

    if (came?.data === undefined) {
      // Unreachable, or refused to parse. Nothing about the enrolment changed while the network
      // was down, so the only thing that would end the attempt here is impatience.
      await waiting.sleep(POLL_SECONDS)
      continue
    }

    const { data } = came

    if (data.kind === 'granted') {
      return {
        kind: 'connected',
        attachment: { origin, machineId: data.machineId, token: data.token },
        lookFor: data.lookFor,
      }
    }
    if (data.kind !== 'waiting') return { kind: 'gave-up', why: data.kind }

    await waiting.sleep(POLL_SECONDS)
  }
}

/** How often to ask while waiting for a person. Short: somebody is watching a terminal. */
const POLL_SECONDS = 2
