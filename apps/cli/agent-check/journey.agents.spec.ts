/**
 * The one suite every adapter has to pass, run against the real binaries.
 *
 * This is the checker behind "adding an agent is an adapter and a line in the registry": the
 * assertions below are written once and run for whatever the registry holds, so an adapter that
 * quietly kept a decision belonging to its caller — retrying, giving a turn a name, deciding that
 * nobody knows how it went — fails here rather than in front of somebody.
 *
 * Against the real thing, and never against a fake. Every promise here is about how an agent
 * actually behaves: what its SDK throws when a session is gone, whether an interrupt is accepted,
 * what a tool call looks like when it comes back. A stand-in would be this program agreeing with
 * itself about all three.
 *
 * Not part of `pnpm check`. It needs both binaries signed in on this machine and it spends real
 * model calls, so it is asked for by name: `pnpm test:agents`. A missing binary fails the run
 * rather than skipping it — a suite that goes green because it did not run is worse than a red one.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Said, Told } from '../src/agents/agent.ts'
import { agentFor, EVERY_KIND } from '../src/agents/known-agents.ts'
import { machineEnvironment } from '../src/env.ts'

/** Long enough for a real model call on a slow morning, short enough to fail rather than hang. */
const ANSWER_WITHIN_MS = 180_000

/** The file a stopped command would go on writing to, if it were not really stopped. */
const TICKS = 'ticks.txt'

/** How far the ticking got. A command that never started leaves nothing, which counts as none. */
async function ticked(where: string): Promise<number> {
  return readFile(where, 'utf8').then(
    (all) => all.length,
    () => 0,
  )
}

/** A directory of its own per turn, so what an agent leaves behind is only ever this test's. */
async function somewhere(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'handover-journey-'))
}

/** Everything one turn said, in the order it was said. */
async function turn(
  kind: string,
  where: string,
  asked: string,
  sofar: string | null = null,
): Promise<readonly Told[]> {
  const agent = agentFor(kind, machineEnvironment())
  if (agent === undefined) throw new Error(`no adapter for ${kind}`)

  const told: Told[] = []
  for await (const one of agent.talk(where, sofar).say({ text: asked })) told.push(one)

  return told
}

const ending = (told: readonly Told[]): Extract<Told, { told: 'ended' }> | undefined =>
  told.find((one) => one.told === 'ended')

const sessionIn = (told: readonly Told[]): string | undefined =>
  told.find((one) => one.told === 'session')?.id

const saidIn = (told: readonly Told[]): readonly Said[] =>
  told.flatMap((one) => (one.told === 'said' ? [one.said] : []))

const spoken = (told: readonly Told[]): string =>
  saidIn(told)
    .flatMap((said) => (said.said === 'text' ? [said.text] : []))
    .join(' ')

describe.each(EVERY_KIND)('%s, as every adapter has to behave', (kind) => {
  it(
    'answers, names the conversation, and says it is done',
    async () => {
      const told = await turn(kind, await somewhere(), 'Reply with exactly the word: pong')

      // The session id is what makes a second turn possible, so a turn that never said one is a
      // conversation that can only ever have one thing said in it.
      expect(sessionIn(told)).toBeTypeOf('string')
      expect(spoken(told).toLowerCase()).toContain('pong')
      expect(ending(told)).toEqual({ told: 'ended', why: { why: 'done' } })
    },
    ANSWER_WITHIN_MS,
  )

  it(
    'says what it did in words a person can read',
    async () => {
      const told = await turn(
        kind,
        await somewhere(),
        'Run the shell command `echo handover-was-here` and then stop.',
      )

      const did = saidIn(told).find((said) => said.said === 'did')
      // A tool call reaches the page as one line, written when there is something to say about
      // it: what ran, and how it went. Half of one — begun and never finished — would be a line
      // that stays spinning forever.
      expect(did).toBeDefined()
      expect(did?.verb).not.toBe('')
      expect(did?.ok).toBe(true)
      expect(ending(told)).toEqual({ told: 'ended', why: { why: 'done' } })
    },
    ANSWER_WITHIN_MS,
  )

  it(
    'remembers the turn before it, when it is handed the name of one',
    async () => {
      const where = await somewhere()
      const first = await turn(kind, where, 'Remember this word: banana. Reply with: ok')
      const sofar = sessionIn(first)
      expect(sofar).toBeTypeOf('string')

      const second = await turn(
        kind,
        where,
        'What word did I ask you to remember? Reply with only that word.',
        sofar ?? null,
      )

      expect(spoken(second).toLowerCase()).toContain('banana')
      expect(second.some((one) => one.told === 'forgot')).toBe(false)
    },
    ANSWER_WITHIN_MS * 2,
  )

  it(
    'says it forgot, rather than failing, when handed a name it no longer has',
    async () => {
      // The one refusal that is not a fault. Recognising it belongs to the adapter — it is the
      // only thing that knows what its own agent's "I have never heard of that" looks like — and
      // getting it wrong sends somebody looking for a fault that was never there.
      const told = await turn(
        kind,
        await somewhere(),
        'Reply with exactly the word: pong',
        '00000000-0000-4000-8000-000000000000',
      )

      expect(told.some((one) => one.told === 'forgot')).toBe(true)
      // And then it answers anyway, from nothing. A forgotten session is a turn that starts over,
      // not a turn that is lost.
      expect(spoken(told).toLowerCase()).toContain('pong')
      expect(ending(told)).toEqual({ told: 'ended', why: { why: 'done' } })
    },
    ANSWER_WITHIN_MS,
  )

  it(
    'stops when asked, calls it cancelled, and the work really stops',
    async () => {
      const where = await somewhere()
      const ticks = join(where, TICKS)
      const agent = agentFor(kind, machineEnvironment())
      if (agent === undefined) throw new Error(`no adapter for ${kind}`)

      const talk = agent.talk(where, null)
      const told: Told[] = []
      for await (const one of talk.say({
        text: `Run this shell command and let it finish: for i in $(seq 1 60); do echo tick >> ${TICKS}; sleep 1; done`,
      })) {
        told.push(one)
        // Stopped once the ticking has actually begun. Counting what it did not finish would be
        // measuring how the agent chose to break the work up — one of them writes a loop that is
        // over before an interrupt could arrive — where what is promised is that the work stops.
        if (one.told === 'said' && one.said.said === 'doing' && one.said.arg.includes(TICKS)) {
          void talk.stop()
        }
      }

      // Cancelled, not failed. Both SDKs report an interrupted turn as trouble of some kind, and
      // only we know it was asked for — a turn somebody stopped on purpose written down as a
      // failure is the page telling them something broke.
      expect(ending(told)).toEqual({ told: 'ended', why: { why: 'cancelled' } })

      // And nothing is still running. An ending that says cancelled while the command goes on
      // ticking is the worst of the three: the page says it is over and the machine disagrees.
      const stopped = await ticked(ticks)
      await new Promise((wake) => setTimeout(wake, 4000))
      expect(await ticked(ticks)).toBe(stopped)
    },
    ANSWER_WITHIN_MS,
  )
})
