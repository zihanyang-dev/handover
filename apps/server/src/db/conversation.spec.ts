/**
 * Somebody watching, on a second connection.
 *
 * A second connection because that is the case worth proving: the browser is held open by one
 * instance and the write happens on another, and what has to cross between them is Postgres.
 */

import { randomUUID } from 'node:crypto'
import { normalizeSlug, type Slug } from '@handover/universal'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Watched } from '../conversation/live.ts'
import { ACTIVITY, ROLES } from '../conversation/transcript.ts'
import { watchers } from '../conversation/watchers.ts'
import { loadEnv } from '../env.ts'
import { createLog } from '../log.ts'
import { newEnrolmentSecret } from '../machine/secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { hashSecret } from '../secret.ts'
import { connect, type Database } from './connection.ts'
import {
  type Said,
  type SaidToAgent,
  askToStop,
  conversationWith,
  machineSays,
  noteAgentSession,
  beginConversation,
  sayTo,
} from './conversation.ts'
import { approveEnrolment, collectEnrolment, openEnrolment } from './enrolment.ts'
import { checkIn, removeMachine, sayGoodbye } from './machine.ts'
import { createSpace } from './space.ts'
import { forgetStranded, openTurn, stopWantedOn, takeOne } from './turn.ts'
import { arrive } from './user.ts'
import { listenForLive } from './watching.ts'

const env = loadEnv()
const db: Database = connect(env)
const watching = watchers()
const listening = listenForLive(env, createLog({ ...env, LOG_LEVEL: 'fatal' }), (happening) => {
  watching.show(happening)
})

/**
 * What a watcher of this conversation is told next, or nothing if nothing arrives.
 *
 * `past` is how far the fixture had already got. A mark travels out through Postgres and back on
 * another connection, so one written while the fixture was being built can still be in flight
 * when the test starts watching — and a test that took that one for its own would pass or fail on
 * timing. Marks at or below it are the fixture's, and are skipped.
 */
async function told(
  conversationId: string,
  { past = 0, within = 3000 }: { past?: number; within?: number } = {},
): Promise<Watched | undefined> {
  return new Promise((settle) => {
    const stop = watching.watch(conversationId, (watched) => {
      if (watched.seen === 'written' && watched.upTo <= past) return
      stop()
      settle(watched)
    })

    setTimeout(() => {
      stop()
      settle(undefined)
    }, within).unref()
  })
}

afterAll(async () => {
  await listening.stop()
  await db.destroy()
})

let RUN = ''
let SPACE = ''
let PERSON = ''

/** The name that will be on the lines they say — for email, the address they signed in with. */
let PERSON_NAME = ''
let MACHINE = ''

beforeEach(async () => {
  RUN = randomUUID()
  const address = `mina-${RUN}@example.com`
  PERSON_NAME = address
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )
  PERSON = arrived.userId

  const name = `Acme ${RUN.slice(0, 8)}`
  const made = await createSpace(db, {
    requestKey: `space-${RUN}`,
    userId: PERSON,
    displayName: name,
    slug: normalizeSlug(name) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
  SPACE = made.space.id

  MACHINE = await attached()
  await checkIn(db, MACHINE, {
    version: undefined,
    found: [{ kind: 'claude-code', version: '2.1.231' }],
  })
})

async function attached(): Promise<string> {
  const secret = newEnrolmentSecret()
  const userCode = newUserCode()
  await openEnrolment(db, {
    kind: 'asking',
    machineName: 'mina-mbp',
    secretHash: secret.hash,
    userCode,
  })
  await approveEnrolment(db, userCode, { userId: PERSON })

  const collected = await collectEnrolment(db, {
    secretHash: secret.hash,
    tokenHash: hashSecret(`hm_${randomUUID()}`),
    machineName: 'mina-mbp',
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')
  return collected.machineId
}

/**
 * A conversation, which is to say somebody's first question — there is no other kind.
 *
 * The opening is this conversation's `turn-1`, and every test below counts from it: a fixture
 * that opened an empty one would be setting up a state nothing in this program can reach.
 */
async function opened(text = 'hello'): Promise<string> {
  const conversation = await beginConversation(db, {
    conversationId: randomUUID(),
    spaceId: SPACE,
    machineId: MACHINE,
    agentKind: 'claude-code',
    saidBy: PERSON,
    asked: { text },
  })
  if (conversation.kind !== 'begun')
    throw new Error(`the fixture could not open one: ${conversation.kind}`)
  return conversation.conversationId
}

async function asks(conversationId: string, key: string, text: string): Promise<SaidToAgent> {
  return sayTo(db, { conversationId, spaceId: SPACE, key, saidBy: PERSON }, { text })
}

/**
 * The same, with the machine having taken that question — what really happens before a machine
 * writes anything at all. A turn nobody took is a turn nothing can end.
 */
async function running(text = 'hello'): Promise<string> {
  const conversationId = await opened(text)

  const taken = await takeOne(db, MACHINE)
  if (taken?.conversationId !== conversationId) throw new Error('the machine took something else')
  return conversationId
}

/**
 * Opened, taken and finished — a conversation sitting still, which is where somebody types next.
 *
 * Opening one leaves a question nobody has answered yet, so a conversation is *working* from its
 * first moment. Tests about what happens to an idle one have to get it there first.
 */
async function answered(text = 'hello'): Promise<string> {
  const conversationId = await running(text)
  await ends(conversationId, 'opening/end')

  return conversationId
}

async function ends(
  conversationId: string,
  key: string,
  how: string = ACTIVITY.done,
): Promise<Said> {
  return machineSays(db, {
    conversationId,
    machineId: MACHINE,
    key,
    message: { role: 'activity', content: { activityType: how } },
  })
}

describe('opening a conversation', () => {
  it('pins it to a machine and an agent that are both there', async () => {
    expect(await opened()).toEqual(expect.any(String))
  })

  it('refuses an agent that machine does not have', async () => {
    const conversation = await beginConversation(db, {
      conversationId: randomUUID(),
      spaceId: SPACE,
      machineId: MACHINE,
      agentKind: 'codex',
      saidBy: PERSON,
      asked: { text: 'anybody there' },
    })

    expect(conversation).toEqual({ kind: 'no-agent' })
  })

  it('refuses a machine from another Space, giving nothing away about it', async () => {
    const conversation = await beginConversation(db, {
      conversationId: randomUUID(),
      spaceId: randomUUID(),
      machineId: MACHINE,
      agentKind: 'claude-code',
      saidBy: PERSON,
      asked: { text: 'anybody there' },
    })

    expect(conversation).toEqual({ kind: 'no-machine' })
  })
})

describe('saying something to an agent', () => {
  it('takes the first thing said', async () => {
    expect(await asks(await opened(), 'turn-1', 'hello')).toEqual({ kind: 'said' })
  })

  it('tells whoever is watching that there is something to read, and how far', async () => {
    // Writing is what says it, in the transaction that wrote it. Said by the callers instead, the
    // one that forgot would be a conversation sitting still on somebody's screen while the agent
    // worked, and nothing would say which caller it was.
    await listening.listening
    // Two lines already: the question that opened it, and the agent finishing with it.
    const conversation = await answered()
    const arriving = told(conversation, { past: 2 })

    await asks(conversation, 'turn-2', 'hello')

    expect(await arriving).toEqual({ seen: 'written', upTo: 3 })
  })

  it('says nothing to them when the same thing is said twice', async () => {
    // Nothing was written the second time. A watcher told to go and read would find what they
    // already had, which is a round trip for nothing on every retry anybody makes.
    await listening.listening
    const conversation = await opened()
    // Waited for rather than assumed: the mark for the first thing said arrives on its own
    // connection, and a watcher that started listening after it would pass by missing it.
    const first = told(conversation, { past: 1 })
    await asks(conversation, 'turn-1', 'hello')
    await first

    const again = told(conversation, { past: 3, within: 500 })
    await asks(conversation, 'turn-1', 'hello')

    expect(await again).toBeUndefined()
  })

  it('does not say it twice when the answer to the first attempt was lost', async () => {
    const conversation = await answered()
    await asks(conversation, 'turn-2', 'hello')

    expect(await asks(conversation, 'turn-2', 'hello')).toEqual({ kind: 'said-already' })
    // The one that opened it, and this one — sent twice and written once.
    expect(await countSaid(conversation)).toBe(2)
  })

  it('interrupts what it is doing, rather than waiting its turn', async () => {
    // Queued instead, somebody who says "no, leave legacy/ alone" watches it go on editing
    // legacy/ until the step it was already on happens to end — the one thing they were trying
    // to prevent. Both facts are written down: that they asked it to stop, and what they said.
    const conversation = await running('hello')

    expect(await asks(conversation, 'turn-2', 'no, leave legacy alone')).toEqual({ kind: 'said' })
    expect(await stopWantedOn(db, MACHINE)).toMatchObject({ conversationId: conversation })
  })

  it('is finished once the last question is answered, however many were interrupted', async () => {
    // Interrupt twice and the middle question never gets a turn: the machine is handed the last
    // one, which is the one the person went on to ask. Counting every question that never got a
    // turn, this conversation reads as working for ever — a spinner nothing can ever stop.
    const conversation = await running('hello')
    await asks(conversation, 'turn-2', 'no, wait')
    await asks(conversation, 'turn-3', 'do this instead')
    await ends(conversation, 'turn-1/end', ACTIVITY.cancelled)

    const taken = await takeOne(db, MACHINE)
    expect(taken?.afterSeq).toBe(5)
    await ends(conversation, 'turn-3/end')

    const read = await conversationWith(db, { conversationId: conversation, spaceId: SPACE })
    expect(read?.working).toEqual({ state: 'idle' })
  })

  it('hands the machine the question somebody stopped it to ask', async () => {
    // The stopped turn ends after the new question was written, so the ending lands after a
    // question it has nothing to do with. Read the wrong way round, the machine would never be
    // given the very thing the person interrupted it for.
    const conversation = await running('hello')
    await asks(conversation, 'turn-2', 'no, leave legacy alone')
    await ends(conversation, 'turn-1/end', ACTIVITY.cancelled)

    const taken = await takeOne(db, MACHINE)
    // Only the new one. The turn it interrupted sits between the two questions, so the one they
    // moved on from is below this turn's bound and cannot come back.
    expect(taken?.asked.map((one) => one.text)).toEqual(['no, leave legacy alone'])
  })

  it('takes the next question once the turn is closed', async () => {
    const conversation = await running('hello')
    await ends(conversation, 'turn-1/end')

    expect(await asks(conversation, 'turn-2', 'and another thing')).toEqual({ kind: 'said' })
  })

  it('keeps both of two racing questions, and hands the machine both', async () => {
    // Two tabs, or two people. Both are written down — losing one would be losing something
    // somebody said — and both go to the agent in the order they were said. Handing it only the
    // last was right while a Space held one person and is losing a message now: the first would
    // sit in the transcript looking queued and never be answered.
    const conversation = await answered()

    const both = await Promise.all([
      asks(conversation, 'turn-1', 'hello'),
      asks(conversation, 'turn-2', 'hello again'),
    ])

    expect(both.filter((one) => one.kind === 'said')).toHaveLength(2)
    expect((await takeOne(db, MACHINE))?.asked.map((one) => one.text)).toEqual([
      'hello',
      'hello again',
    ])
  })

  it('keeps what somebody says to a machine that has gone, for when it comes back', async () => {
    // Nothing is ever sent to a machine — it asks, and is handed everything said since its last
    // turn. So a shut laptop is not a reason to throw somebody's words away before writing them
    // down; it is a reason to show them it is not here, which the transcript already carries.
    const conversation = await opened()
    await sayGoodbye(db, MACHINE)

    expect(await asks(conversation, 'turn-1', 'hello')).toEqual({ kind: 'said' })
  })

  it('refuses a conversation in another Space, giving nothing away about it', async () => {
    const conversation = await opened()

    const said = await sayTo(
      db,
      { conversationId: conversation, spaceId: randomUUID(), key: 'turn-1', saidBy: PERSON },
      { text: 'hello' },
    )

    expect(said).toEqual({ kind: 'no-conversation' })
  })

  it('refuses a machine its owner took away while the request was already inside', async () => {
    // Its credential is refused at the door from the next call on. This is the call already
    // through it: the middleware let it past before the removal committed, and a line written now
    // would be one more line from a machine nobody can reach any more.
    const conversation = await opened()
    await removeMachine(db, { machine: MACHINE, owner: PERSON })

    const said = await machineSays(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'turn-1/said',
      message: { role: 'assistant', content: { text: 'hello back' } },
    })

    expect(said).toEqual({ kind: 'no-conversation' })
  })
})

describe('taking a question', () => {
  it('is the question nobody has taken yet', async () => {
    const conversation = await opened('hello')

    expect(await takeOne(db, MACHINE)).toMatchObject({
      conversationId: conversation,
      agentKind: 'claude-code',
      agentSession: null,
      asked: [{ text: 'hello', who: PERSON_NAME }],
    })
  })

  it('is still waiting when somebody asked to stop it before anybody picked it up', async () => {
    // A request to stop is not an answer. Counted as one, it hides the question from the only
    // machine that could ever end the turn — and the conversation reads as working forever,
    // because the person asking to stop it is what buried it.
    const conversation = await opened('take your time')
    await askToStop(db, { conversationId: conversation, spaceId: SPACE, key: 'stop-1' })

    expect(await takeOne(db, MACHINE)).toMatchObject({ conversationId: conversation })
  })

  it('is nothing once the turn has been taken, however little it has said', async () => {
    // The whole reason the ledger exists. An agent that started and then died before writing its
    // first line used to leave a question that still looked untouched — handed out again, running
    // whatever it had already done a second time.
    await opened('hello')
    await takeOne(db, MACHINE)

    expect(await takeOne(db, MACHINE)).toBeUndefined()
  })

  it('is nothing once the turn is closed', async () => {
    const conversation = await opened('hello')
    await takeOne(db, MACHINE)
    await ends(conversation, 'turn-1/end')

    expect(await takeOne(db, MACHINE)).toBeUndefined()
  })

  it('is the longest-waiting one when two conversations are both asking', async () => {
    const first = await opened('the older question')
    await opened('the newer question')

    expect(await takeOne(db, MACHINE)).toMatchObject({ conversationId: first })
  })

  it('carries the session once the agent has named one', async () => {
    const conversation = await opened()
    await noteAgentSession(db, { conversationId: conversation, machineId: MACHINE, session: 'abc' })
    await asks(conversation, 'turn-1', 'hello')

    expect(await takeOne(db, MACHINE)).toMatchObject({ agentSession: 'abc' })
  })
})

describe('what a machine may write', () => {
  it('refuses a conversation that was never given to it', async () => {
    const conversation = await opened()
    const stranger = await attached()

    const said = await machineSays(db, {
      conversationId: conversation,
      machineId: stranger,
      key: 'turn-1/said',
      message: { role: 'assistant', content: { text: 'hello back' } },
    })

    expect(said).toEqual({ kind: 'no-conversation' })
  })
})

describe('what the agent calls a conversation', () => {
  it('keeps the first name it was given', async () => {
    // Picking a conversation up again reports the same id; a turn that started over says so by
    // its own means. Overwriting would lose the pointer to everything said before.
    const conversation = await opened()
    await noteAgentSession(db, { conversationId: conversation, machineId: MACHINE, session: 'one' })
    await noteAgentSession(db, { conversationId: conversation, machineId: MACHINE, session: 'two' })
    await asks(conversation, 'turn-1', 'hello')

    expect(await takeOne(db, MACHINE)).toMatchObject({ agentSession: 'one' })
  })
})

async function countMessages(conversationId: string): Promise<number> {
  const counted = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('conversation_id', '=', conversationId)
    .executeTakeFirstOrThrow()

  return Number(counted.total)
}

/** Only what people said. The lines a stop or an ending writes are not somebody saying twice. */
async function countSaid(conversationId: string): Promise<number> {
  const counted = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('conversation_id', '=', conversationId)
    .where('role', '=', 'user')
    .executeTakeFirstOrThrow()

  return Number(counted.total)
}

async function asksToStop(conversationId: string, key = 'turn-1/stop') {
  return askToStop(db, { conversationId, spaceId: SPACE, key })
}

describe('asking an agent to stop', () => {
  it('is allowed while it is working, which is the only time it means anything', async () => {
    const conversation = await opened('take your time')

    expect(await asksToStop(conversation)).toEqual({ kind: 'asked-to-stop' })
  })

  it('refuses when nothing is running', async () => {
    const conversation = await answered()

    expect(await asksToStop(conversation)).toEqual({ kind: 'nothing-to-stop' })
  })

  it('changes nothing the second time', async () => {
    const conversation = await opened('take your time')
    await asksToStop(conversation)

    expect(await asksToStop(conversation)).toEqual({ kind: 'asked-already' })
    expect(await countMessages(conversation)).toBe(2)
  })

  it('reaches the machine through the report it was already making', async () => {
    const conversation = await running('take your time')
    await asksToStop(conversation)

    expect(await stopWantedOn(db, MACHINE)).toMatchObject({ conversationId: conversation })
  })

  it('is still wanted after the agent has said several more things', async () => {
    // The request is not the last word for long: an agent goes on working until it is reached,
    // and every line it writes in the meantime would otherwise bury the request meant to stop it.
    const conversation = await running('take your time')
    await asksToStop(conversation)
    for (const n of [1, 2, 3]) {
      await machineSays(db, {
        conversationId: conversation,
        machineId: MACHINE,
        key: `turn-1/${n}`,
        message: { role: 'assistant', content: { text: `still going ${n}` } },
      })
    }

    expect(await stopWantedOn(db, MACHINE)).toMatchObject({ conversationId: conversation })
  })

  it('stops being asked for once the agent says it stopped', async () => {
    // Nothing clears it: the request is the last thing said until the turn closes, and closing
    // the turn is what makes it no longer the last thing said.
    const conversation = await opened('take your time')
    await asksToStop(conversation)
    await machineSays(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'turn-1/end',
      message: { role: 'activity', content: { activityType: ACTIVITY.cancelled } },
    })

    expect(await stopWantedOn(db, MACHINE)).toBeUndefined()
  })

  it('leaves the turn open until it actually stops', async () => {
    // Asked and stopped are two facts. A turn that was asked to stop and never did is exactly the
    // case somebody needs to be able to see.
    const conversation = await running('take your time')
    await asksToStop(conversation)

    expect(await db.transaction().execute(async (tx) => openTurn(tx, conversation))).toBe(1)
  })
})

describe('a turn nobody was watching', () => {
  it('is closed as unknown when the machine says it has just started', async () => {
    // Killing the process that drives an agent does not kill the agent, so it went on working
    // with nobody there. What it did is not knowable from here, and guessing either way is worse.
    const conversation = await running('take your time')
    await machineSays(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'turn-1/1',
      message: { role: 'assistant', content: { text: 'on it' } },
    })

    expect(await forgetStranded(db, MACHINE)).toBe(1)

    const read = await conversationWith(db, { conversationId: conversation, spaceId: SPACE })
    expect(read?.messages.at(-1)?.content).toEqual({ activityType: ACTIVITY.unknown })
    expect(read?.working).toEqual({ state: 'idle' })
  })

  it('leaves a question nobody has started alone', async () => {
    // Nothing was abandoned: no agent ever saw it, and it is still waiting to be answered.
    const conversation = await opened('hello')

    expect(await forgetStranded(db, MACHINE)).toBe(0)
    expect(await takeOne(db, MACHINE)).toMatchObject({ conversationId: conversation })
  })

  it('leaves a finished conversation alone', async () => {
    const conversation = await running('hello')
    await ends(conversation, 'turn-1/end')

    expect(await forgetStranded(db, MACHINE)).toBe(0)
  })

  it('cannot be asked to close two on one machine, because there cannot be two', async () => {
    // One at a time, decided by the database rather than by whoever asks. Two instances can both
    // read "nothing open on this machine" before either commits — no primary key stops that, and
    // no test can, since it depends on which statement commits first. The unique partial index
    // can, and this is it.
    const first = await running('take your time')
    const second = await opened('and this one')
    if (first === second) throw new Error('the fixture opened one conversation twice')

    await expect(
      db
        .insertInto('turns')
        .values({ conversation_id: second, after_seq: 1, machine_id: MACHINE })
        .execute(),
    ).rejects.toThrow(/turns_one_open_per_machine/u)
  })
})

describe('whose words are whose', () => {
  it('writes down which person said it, not only that a person did', async () => {
    // `prd.md` 05 ⑦ promised this and `messages` could not keep it: with two people in a Space,
    // `role: 'user'` says somebody spoke about a line that has to read as a name.
    const conversation = await opened('where does the timeout live?')

    const line = await db
      .selectFrom('messages')
      .select(['role', 'said_by as saidBy'])
      .where('conversation_id', '=', conversation)
      .where('role', '=', 'user')
      .executeTakeFirstOrThrow()

    expect([line.role, line.saidBy]).toEqual(['user', PERSON])
  })

  it('leaves the other three kinds without one, because nobody said them', async () => {
    const conversation = await opened('hello')
    await machineSays(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'answered',
      message: { role: 'assistant', content: { text: 'In client.ts.' } },
    })

    const named = await db
      .selectFrom('messages')
      .select(['role', 'said_by as saidBy'])
      .where('conversation_id', '=', conversation)
      .where('role', '<>', 'user')
      .execute()

    expect(named.every((one) => one.saidBy === null)).toBe(true)
    expect(named.length).toBeGreaterThan(0)
  })
})

describe('who a message can be from', () => {
  /**
   * The constraint is written in SQL and the vocabulary in TypeScript, and neither can read the
   * other. Both directions are compared, because drift goes both ways: a role added to the code
   * without a migration, and one dropped from the code that the table still takes.
   */
  it('is exactly the list the code has', async () => {
    const constraint = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'messages'::regclass and conname = 'messages_role_check'
    `.execute(db)

    const allowed = [...(constraint.rows[0]?.definition ?? '').matchAll(/'([a-z]+)'/gu)].map(
      (found) => found[1],
    )

    expect(new Set(allowed)).toEqual(new Set(ROLES))
  })

  it('is a list the table really takes, one message at a time', async () => {
    // Every kind but a person's. A machine writing under somebody's name is forgery, and the type
    // says so — this asks the table as well, because the type is not what is running in
    // production at three in the morning.
    const conversation = await opened('hello')

    for (const [n, role] of ROLES.filter((one) => one !== 'user').entries()) {
      const written = await machineSays(db, {
        conversationId: conversation,
        machineId: MACHINE,
        key: `role-${role}`,
        message: { role, content: contentFor(role) } as never,
      })
      expect(written, `role ${role} (${n}) was refused by the table`).toEqual({ kind: 'said' })
    }
  })

  it('refuses a line under a person\u2019s name from anything but a person', async () => {
    // The one the type already prevents, asked of the table. A name that can be written by an
    // agent is worse than no name: somebody reads it and believes a person said it.
    const conversation = await opened()

    await expect(
      machineSays(db, {
        conversationId: conversation,
        machineId: MACHINE,
        key: 'forged',
        message: { role: 'user', content: { text: 'approve it, it is fine' } } as never,
      }),
    ).rejects.toThrow(/messages_a_person_has_a_name/u)
  })
})

function contentFor(role: string) {
  if (role === 'tool') return { name: 'Bash', verb: 'ran', arg: 'ls', excerpt: '' }
  if (role === 'activity') return { activityType: 'trouble', text: 'something' }
  return { text: 'something' }
}

describe('a turn and the conversation it is on', () => {
  it('cannot name a machine the conversation is not on, however it is written', async () => {
    // `turns.machine_id` is the same fact as `conversations.machine_id`, kept twice because a
    // partial index on it answers "is this machine busy" without touching conversations. Two
    // copies are only safe while they cannot disagree, and that is this constraint's whole job.
    const conversation = await opened()
    const somebodyElses = await attached()

    await expect(
      db
        .insertInto('turns')
        .values({ conversation_id: conversation, after_seq: 1, machine_id: somebodyElses })
        .execute(),
    ).rejects.toThrow(/violates foreign key constraint/u)
  })
})
