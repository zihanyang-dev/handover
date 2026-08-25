/**
 * Asking to come in, and waiting for somebody to say yes.
 *
 * The waiting is a plain loop against one endpoint. There is no callback and no local port, so it
 * works the same on a laptop and on a server nobody can reach — which is the whole reason the
 * approving happens on whatever device the person has to hand.
 */

import type { Api } from './api.ts'
import type { components } from '../generated/api.ts'
import type { Attachment } from './store.ts'

/** How often to ask while waiting for a person. Short: somebody is watching a terminal. */
const POLL_SECONDS = 2

/** What came back from asking, and what was asked with — the name is part of the request. */
export type Asked = {
  readonly machineName: string
  readonly secret: string
  readonly userCode: string
  readonly verifyUrl: string
  readonly verifyUrlComplete: string
  readonly expiresAt: string
}

export type Connected =
  | { readonly kind: 'connected'; readonly attachment: Attachment }
  /** Somebody said no, it ran out, or somebody else took the key. Each ends the attempt. */
  | { readonly kind: 'gave-up'; readonly why: Why }

/** Every way this ends without getting in — taken from the contract, plus the one only we can see. */
export type Why =
  Exclude<components['schemas']['Collected']['kind'], 'granted' | 'waiting'> | 'unreachable'

/**
 * What to say about each, which depends on which door was used.
 *
 * The same word off the wire means two different things to a person: `spent` at a terminal
 * showing a code is "somebody else typed it, run this again", and `spent` with a key pasted in is
 * "that key is used up, make another in the Space". One is something to redo here, the other is
 * something to go and do elsewhere, and telling somebody the wrong one sends them to the wrong
 * screen. Written as two lists rather than one, because they really are two.
 *
 * `Record<Why, string>` twice over is the guard: a kind the server starts returning has nowhere to
 * hide, and neither does a door that forgot to answer for it.
 */
export const SAID: Record<'code' | 'key', Record<Why, string>> = {
  code: {
    refused: 'somebody said no. Nothing changed — run this again to ask afresh.',
    expired: 'the code ran out before anybody answered. Run this again for a new one.',
    spent: 'that code was already used. Run this again for a new one.',
    'no-enrolment': 'nothing is waiting under that code any more. Run this again.',
    unreachable: 'could not reach the server. Check it is up, then run this again.',
  },
  key: {
    refused: 'that key was turned down. Make a new one in the Space.',
    expired: 'that key has run out. Make a new one in the Space.',
    spent: 'that key has already been used. A key works once — make a new one in the Space.',
    'no-enrolment': 'that key does not work. Make a new one in the Space.',
    unreachable: 'could not reach the server. Check it is up, then run this again.',
  },
}

export type Waiting = {
  /** Called once, with what to show. Printing is the caller's job, not this loop's. */
  readonly show: (asked: Asked) => void
  readonly sleep: (seconds: number) => Promise<void>
}

/**
 * Collects a credential with a key somebody already generated.
 *
 * No waiting and no code: generating the key in a Space *was* the approval, so there is nobody
 * left to ask. For a machine with no browser to open, which is most machines that are not
 * somebody's laptop.
 */
export async function connectWithKey(
  api: Api,
  origin: string,
  key: string,
  machineName: string,
): Promise<Connected> {
  // Unlike the waiting path there is nothing to sit through: a key that does not work now will
  // not start working, so a failure here ends the attempt rather than becoming a retry.
  const came = await api.POST('/enrolments/collect', { body: { secret: key, machineName } })

  if (came.data === undefined) return { kind: 'gave-up', why: 'unreachable' }

  if (came.data.kind !== 'granted') {
    const { kind } = came.data
    // Making a key is the approving, so nothing a key opens can still be waiting on an answer.
    // One that is means a key was made nobody approved, and there is no code to show anybody
    // about it — nothing this can say to a person would be true, so it says it here instead.
    if (kind === 'waiting') throw new Error('a key came back waiting: it was never approved')
    return { kind: 'gave-up', why: kind }
  }

  return {
    kind: 'connected',
    attachment: {
      origin,
      machineId: came.data.machineId,
      token: came.data.token,
      lookFor: came.data.lookFor,
    },
  }
}

/** Nothing back means nobody answered — the caller's business, not a reason to end the program. */
export async function askToConnect(api: Api, machineName: string): Promise<Asked | undefined> {
  const { data } = await api.POST('/enrolments', { body: { machineName } })
  if (data === undefined) return undefined

  return { machineName, ...data }
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
    const came = await api.POST('/enrolments/collect', {
      body: { secret: asked.secret, machineName: asked.machineName },
    })

    if (came.data === undefined) {
      // Unreachable, or refused to parse. Nothing about the enrolment changed while the network
      // was down, so the only thing that would end the attempt here is impatience.
      await waiting.sleep(POLL_SECONDS)
      continue
    }

    const { data } = came

    if (data.kind === 'granted') {
      return {
        kind: 'connected',
        attachment: {
          origin,
          machineId: data.machineId,
          token: data.token,
          lookFor: data.lookFor,
        },
      }
    }
    if (data.kind !== 'waiting') return { kind: 'gave-up', why: data.kind }

    await waiting.sleep(POLL_SECONDS)
  }
}
