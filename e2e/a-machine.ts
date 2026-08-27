/**
 * A machine, speaking the protocol a real one speaks.
 *
 * It enrols, collects a credential, reports in, takes the turns it is handed and writes what it
 * "did" — every one of those over the same HTTP the CLI uses, against the same routes. What it
 * stands in for is one thing only: the agent process. Driving a real Claude or Codex through a
 * browser journey would make the suite slow and its assertions guesses, and how those two behave
 * is held by `agent-check/journey.agents.spec.ts` against the real binaries.
 *
 * So: everything between the browser and the agent is real here, and the agent is a script.
 */

import { randomUUID } from 'node:crypto'

const ORIGIN = 'http://localhost:3199'

type Asking = {
  readonly conversationId: string
  readonly afterSeq: number
  readonly asked?: { readonly text: string }
}

export type Machine = {
  /** Report in, and take a turn if one is waiting. Answers nothing when there is none. */
  readonly poll: () => Promise<Asking | undefined>
  /** Say something into a conversation, as the agent would. */
  readonly says: (asking: Asking, message: unknown) => Promise<void>
  /** Finish the turn it is on. */
  readonly ends: (asking: Asking, how?: string) => Promise<void>
  /**
   * Stop the piece of work and say why, which is what `handover task wait` does.
   *
   * Not a line in the transcript: what is true *now* lives in the ledger, and nothing decides
   * anything by reading what was said. Writing "it asked you" into the conversation and expecting
   * the work to stop is the mistake this method exists to not make.
   */
  readonly stops: (asking: Asking, how: unknown) => Promise<void>
  readonly id: string
}

/**
 * Connects a machine to whoever holds this session, the way `handover connect --key` does.
 *
 * A key *is* the approval, so there is no code and nobody to wait for: the key is the secret this
 * hands in, and what comes back is the machine's own credential.
 */
export async function aMachine(sessionToken: string, name: string): Promise<Machine> {
  const made = await ask('/me/machine-keys', { cookie: `handover_session=${sessionToken}` })
  const token = `hm_${randomUUID()}`

  const collected = await ask(
    '/enrolments/collect',
    {},
    { secret: (made as { key: string }).key, machineName: name, token },
  )
  const how = (collected as { kind: string }).kind
  if (how !== 'granted') throw new Error(`the machine was not let in: ${how}`)

  const authorization = `Bearer ${token}`
  const machine: Machine = {
    id: name,
    poll: async () => {
      const said = await ask(
        '/machines/current/poll',
        { authorization },
        { found: [{ command: 'claude', version: '2.1.4' }] },
      )

      return (said as { asking?: Asking }).asking
    },
    says: async (asking, message) => {
      await ask(
        `/machines/current/conversations/${asking.conversationId}/messages`,
        { authorization },
        { key: `${String(asking.afterSeq)}/${randomUUID()}`, message },
      )
    },
    stops: async (asking, how) => {
      await ask(
        `/machines/current/conversations/${asking.conversationId}/task`,
        { authorization },
        { key: `${String(asking.afterSeq)}/stop-${randomUUID()}`, how },
        'PATCH',
      )
    },
    ends: async (asking, how = 'done') => {
      await ask(
        `/machines/current/conversations/${asking.conversationId}/messages`,
        { authorization },
        {
          key: `${String(asking.afterSeq)}/end-${how}`,
          message: { role: 'activity', content: { activityType: how } },
        },
      )
    },
  }

  return machine
}

/** Waits for a turn, because a machine is told about one by asking rather than being called. */
export async function waitsForATurn(machine: Machine, seconds = 20): Promise<Asking> {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const asking = await machine.poll()
    if (asking !== undefined) return asking
  }

  throw new Error('no turn arrived')
}

async function ask(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = 'POST',
): Promise<unknown> {
  const answered = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!answered.ok) throw new Error(`${path} answered ${String(answered.status)}`)

  return answered.status === 204 ? undefined : await answered.json()
}
