/**
 * A piece of work somebody handed over.
 *
 * What is under test everywhere here is the same question asked two ways: **is this machine owed
 * a turn**, and **who has to do something**. Both are answered from `tasks.state` and never by
 * reading the transcript, which is the one rule this slice exists to hold.
 */

import { randomUUID } from 'node:crypto'
import { normalizeSlug, type Slug } from '@handover/universal'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVITY } from '../conversation/transcript.ts'
import { loadEnv } from '../env.ts'
import { SILENT_FOR_SECONDS } from '../machine/presence.ts'
import { newEnrolmentSecret } from '../machine/secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { hashSecret } from '../secret.ts'
import { connect, type Database } from './connection.ts'
import {
  conversationsIn,
  handOffTo,
  machineSays,
  beginConversation,
  sayTo,
} from './conversation.ts'
import { approveEnrolment, collectEnrolment, openEnrolment } from './enrolment.ts'
import { checkIn, removeMachine } from './machine.ts'
import { handWorkTo, joins, removes } from './membership.ts'
import { createSpace } from './space.ts'
import {
  handOver,
  stopsWorking,
  takeBack,
  tellWhoeverIsWaitingOnAGoneMachine,
  underwayIn,
  waitingOn,
  wakeWhoseTimeHasCome,
  writesOutput,
} from './task.ts'
import { forgetStranded, openTurn, stopsWantedOn, takeOne } from './turn.ts'
import { arrive } from './user.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

let RUN = ''
let SPACE = ''
let PERSON = ''
let MACHINE = ''

beforeEach(async () => {
  RUN = randomUUID()
  const address = `mina-${RUN}@example.com`
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
    emoji: '🏠',
    slug: normalizeSlug(name) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
  SPACE = made.space.id

  MACHINE = await attached('mina-mbp')
})

/** A second person, in this Space. Until `05` there was never one, so nothing needed it. */
async function alsoHere(): Promise<string> {
  const address = `rui-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )
  await joins(db, { userId: arrived.userId, spaceId: SPACE, slug: `s-${RUN.slice(0, 8)}` })

  return arrived.userId
}

async function attached(machineName: string): Promise<string> {
  const secret = newEnrolmentSecret()
  const userCode = newUserCode()
  await openEnrolment(db, { kind: 'asking', machineName, secretHash: secret.hash, userCode })
  await approveEnrolment(db, userCode, { userId: PERSON })

  const collected = await collectEnrolment(db, {
    secretHash: secret.hash,
    tokenHash: hashSecret(`hm_${randomUUID()}`),
    machineName,
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')

  await checkIn(db, collected.machineId, {
    version: undefined,
    connectedIn: undefined,
    found: [
      { kind: 'claude-code', version: '2.1.231' },
      { kind: 'codex', version: '0.148.0' },
    ],
  })
  return collected.machineId
}

/** A machine that stopped answering: silent for longer than anybody waits before calling it gone. */
/**
 * By id, because a name is not an identity — and this database is shared by every spec file
 * running at the same time. Named, this silenced every machine anybody had called the same thing,
 * and other files' fixtures failed with `machine-away` somewhere else entirely.
 */
async function wentSilent(machineId: string): Promise<void> {
  await db
    .updateTable('machines')
    .set({ last_seen_at: sql<Date>`now() - ${SILENT_FOR_SECONDS + 60} * interval '1 second'` })
    .where('id', '=', machineId)
    .execute()
}

/**
 * Everything written into a conversation, as one string to look for words in.
 *
 * Ordered, because one test compares two of these to prove a line was written exactly once — and
 * without an `order by` Postgres may hand the same rows back in a different order after anything
 * changes the pages they sit on. That test then fails on a transcript nothing wrote to, and would
 * have passed on one where a line really was written twice if the orders happened to agree.
 */
async function heard(conversationId: string): Promise<string> {
  const said = await db
    .selectFrom('messages')
    .select('content')
    .where('conversation_id', '=', conversationId)
    .orderBy('seq')
    .execute()

  return JSON.stringify(said)
}

/** A conversation is somebody's first question, so the fixture asks one. */
async function opened(text = 'the first thing anybody said', machineId = MACHINE): Promise<string> {
  const conversation = await beginConversation(db, {
    conversationId: randomUUID(),
    spaceId: SPACE,
    machineId,
    agentKind: 'claude-code',
    saidBy: PERSON,
    asked: { text },
  })
  if (conversation.kind !== 'begun')
    throw new Error(`the fixture could not open one: ${conversation.kind}`)
  return conversation.conversationId
}

/** Somebody says something, and the machine takes the turn it is owed. */
async function asks(conversationId: string, key: string, text: string): Promise<void> {
  const said = await sayTo(db, { conversationId, spaceId: SPACE, key, saidBy: PERSON }, { text })
  if (said.kind !== 'said') throw new Error(`the fixture could not ask: ${said.kind}`)
}

/** The card an agent puts in front of a person, and the transcript identity of that exact card. */
async function proposes(
  conversationId: string,
  key: string,
  text: string,
  machineId = MACHINE,
): Promise<number> {
  const said = await machineSays(db, {
    conversationId,
    machineId,
    key,
    message: { role: 'activity', content: { activityType: ACTIVITY.proposed, text } },
  })
  if (said.kind !== 'said') throw new Error(`the fixture could not propose: ${said.kind}`)

  const written = await db
    .selectFrom('messages')
    .select('seq')
    .where('conversation_id', '=', conversationId)
    .where('key', '=', key)
    .executeTakeFirstOrThrow()
  return written.seq
}

/** The same person, a second Space, a machine of theirs in it, and work handed over there. */
async function inAnotherSpace(): Promise<string> {
  const name = `Beta ${RUN.slice(0, 8)}`
  const made = await createSpace(db, {
    requestKey: `beta-${RUN}`,
    userId: PERSON,
    displayName: name,
    emoji: '🏠',
    slug: normalizeSlug(name) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a second Space')

  // Their machine is reachable from there without being connected again — which is the whole
  // reason a person can have work waiting in two Spaces at once.
  const opened = await beginConversation(db, {
    conversationId: randomUUID(),
    spaceId: made.space.id,
    machineId: MACHINE,
    agentKind: 'claude-code',
    saidBy: PERSON,
    asked: { text: 'take it from here' },
  })
  if (opened.kind !== 'begun')
    throw new Error(`the fixture could not open one there: ${opened.kind}`)

  const proposalSeq = await proposes(
    opened.conversationId,
    `beta-proposal-${RUN}`,
    'watch the numbers',
  )
  const over = await handOver(db, {
    conversationId: opened.conversationId,
    spaceId: made.space.id,
    key: `beta-over-${RUN}`,
    userId: PERSON,
    proposalSeq,
  })
  if (over.kind !== 'handed-over') throw new Error('the fixture could not hand over there')
  await takeOne(db, MACHINE)

  return opened.conversationId
}

/** Handed over, and the first turn taken — where every one of these tests starts. */
async function handedOver(goal = 'make the timeout configurable'): Promise<string> {
  const conversation = await opened()
  await asks(conversation, 'turn-1', 'take it from here')

  const proposalSeq = await proposes(conversation, `proposal-${RUN}`, goal)
  const over = await handOver(db, {
    conversationId: conversation,
    spaceId: SPACE,
    key: `over-${RUN}`,
    userId: PERSON,
    proposalSeq,
  })
  if (over.kind !== 'handed-over') throw new Error(`the fixture could not hand over: ${over.kind}`)

  return conversation
}

/** The machine ends whatever turn it is on. */
async function ends(conversationId: string, key: string, how: string = ACTIVITY.done) {
  return machineSays(db, {
    conversationId,
    machineId: MACHINE,
    key,
    message: { role: 'activity', content: { activityType: how } },
  })
}

/** Whether this machine is owed a turn right now, and in which conversation. */
async function nextTurn(machineId = MACHINE): Promise<string | undefined> {
  return (await takeOne(db, machineId))?.conversationId
}

function reporting(conversationId: string, key: string, machineId = MACHINE) {
  return { conversationId, machineId, key }
}

/** The commonest of the three ways to stop: it asked whoever handed this out. */
function asking(question: string) {
  return { state: 'wait', question } as const
}

describe('handing a conversation over', () => {
  it('starts it moving without anybody saying anything else', async () => {
    const conversation = await handedOver()
    // The turn the person's own words earned, and then one nobody asked for.
    expect(await nextTurn()).toBe(conversation)
    await ends(conversation, '1/end')

    expect(await nextTurn()).toBe(conversation)
  })

  it('refuses a second one while the first is still running', async () => {
    const conversation = await handedOver()

    const again = await handOver(db, {
      conversationId: conversation,
      spaceId: SPACE,
      key: 'over-again',
      userId: PERSON,
      proposalSeq: 1,
    })

    expect(again).toEqual({ kind: 'already-handed-over' })
  })

  it('leaves a conversation nobody handed over exactly as it was', async () => {
    // The whole of slice 03 has to keep working: a turn ends, and that is the end of it until
    // somebody says something.
    const conversation = await opened()
    await asks(conversation, 'turn-1', 'where does the timeout live?')
    expect(await nextTurn()).toBe(conversation)
    await ends(conversation, '1/end')

    expect(await nextTurn()).toBeUndefined()
  })
})

describe('when it stops', () => {
  it('waits for its owner once it has asked them something', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('A or B?'))
    await ends(conversation, '1/end')

    expect(await nextTurn()).toBeUndefined()
  })

  it('starts again the moment they answer, and both facts move together', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('A or B?'))
    await ends(conversation, '1/end')

    await asks(conversation, 'turn-2', 'A')

    expect(await nextTurn()).toBe(conversation)
  })

  it('sleeps until the moment it named, and no scheduler is involved', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'sleep-1'), {
      state: 'sleep',
      until: new Date(Date.now() + 60_000),
    })
    await ends(conversation, '1/end')
    expect(await nextTurn()).toBeUndefined()

    // The moment arrives on its own. All the waker does is tell the machine to look again.
    await db
      .updateTable('tasks')
      .set({ sleep_until: new Date(Date.now() - 1000) })
      .where('conversation_id', '=', conversation)
      .execute()
    // At least: the waker is deployment-wide, and every other test in this file that put
    // something to sleep is still asleep in the same database.
    expect(await wakeWhoseTimeHasCome(db)).toBeGreaterThanOrEqual(1)

    expect(await nextTurn()).toBe(conversation)
  })

  it('is woken by a person saying something, without waiting out the moment', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'sleep-1'), {
      state: 'sleep',
      until: new Date(Date.now() + 60_000),
    })
    await ends(conversation, '1/end')

    await asks(conversation, 'turn-2', 'never mind, look now')

    expect(await nextTurn()).toBe(conversation)
  })
})

describe('a turn that went wrong', () => {
  it('stops it, because whether it matters is a person to say', async () => {
    // The whole of "it does not retry itself": it is not handed a turn, rather than told not to.
    const conversation = await handedOver()
    await nextTurn()
    await ends(conversation, '1/end', ACTIVITY.failed)

    expect(await nextTurn()).toBeUndefined()
  })

  it('does the same when nobody knows how the turn went', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await ends(conversation, '1/end', ACTIVITY.unknown)

    expect(await nextTurn()).toBeUndefined()
  })

  it('carries on after one somebody interrupted, which is not trouble', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await ends(conversation, '1/end', ACTIVITY.cancelled)

    expect(await nextTurn()).toBe(conversation)
  })
})

describe('handing a piece of it to somebody else', () => {
  async function handedOff(conversation: string, goal = 'add an integration test') {
    const off = await handOffTo(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: `off-${goal}`,
      agentKind: 'codex',
      goal,
    })
    if (off.kind !== 'handed-off') throw new Error(`could not hand off: ${off.kind}`)
    return off
  }

  it('opens a conversation of its own, on the machine it is already running on', async () => {
    const conversation = await handedOver()
    await nextTurn()

    const off = await handedOff(conversation)

    expect(off.conversationId).not.toBe(conversation)
    expect(await nextTurn()).toBe(off.conversationId)
  })

  it('tells the machine which piece of work it belongs to, so it knows where to put it', async () => {
    // The only thing the machine is told about where to work, and it is not a path: this
    // deployment has never seen that disk. A sub-task goes in a folder under the one its parent
    // is working in — which is the whole of how it reads what that work has been writing.
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)

    expect(await takeOne(db, MACHINE)).toMatchObject({
      conversationId: off.conversationId,
      subtaskOf: conversation,
    })
  })

  it('still knows which work a sub-task belongs to after that work has ended', async () => {
    // Where a turn runs cannot depend on which half of the look claimed it. A sub-task is owed
    // turns as work while its piece of work is open, and as an ordinary conversation once a
    // person types into it afterwards — and the folder it worked in the whole time is the same
    // folder. Read off the open task alone, the second kind lands somewhere else, the agent
    // opens an empty directory, and everything it did is apparently gone.
    const conversation = await handedOver()
    await nextTurn()
    const child = await handedOff(conversation)
    await ends(conversation, '1/end')
    await nextTurn()
    await stopsWorking(db, reporting(child.conversationId, 'fin'), {
      state: 'done',
      ending: 'done',
      said: 'added it',
    })
    await asks(child.conversationId, 'later', 'one more thing while you are there')

    // The parent is owed one first — it has been waiting since before that question was asked.
    expect(await nextTurn()).toBe(conversation)

    expect(await takeOne(db, MACHINE)).toMatchObject({
      conversationId: child.conversationId,
      subtaskOf: conversation,
    })
  })

  it('leaves it here even when another machine in the Space would take it', async () => {
    // `prd.md` 07 ⑥. Nobody is in the room when an agent decides this, so it does not get to
    // decide whose computer runs it. A person handing you something leaves a name against it;
    // this would leave nothing at all — and the machine it picked could be somebody's laptop.
    const conversation = await handedOver()
    await nextTurn()
    const somebodyElses = await attached('build-server-1')

    const off = await handedOff(conversation)

    expect(await nextTurn(somebodyElses)).toBeUndefined()
    expect(await nextTurn()).toBe(off.conversationId)
  })

  it('does not stop the one handing off, so it can open a second', async () => {
    // Blocking on the first would make parallel impossible: it never gets to say the second one.
    const conversation = await handedOver()
    await nextTurn()

    await handedOff(conversation, 'one')
    await handedOff(conversation, 'two')

    expect(await underwayIn(db, conversation)).toMatchObject({ handedOff: [{ goal: 'one' }, {}] })
  })

  it('stops it once its own turn ends, for as long as any of them are open', async () => {
    // Not a state it declares — the count of its open children, which cannot go stale.
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)
    await ends(conversation, '1/end')

    // Its own machine has room for more; what it does not have is any reason to run this one.
    expect(await nextTurn()).toBe(off.conversationId)
    expect(await nextTurn()).toBeUndefined()
  })

  it('opens as many as it likes, because what limits them is counted elsewhere', async () => {
    // No count here, on purpose. How many run at once is `agent_settings.at_once`, asked when a
    // turn is handed out — a rule here would be the same limit written a second time, in the one
    // place that cannot see how many are actually running.
    const conversation = await handedOver()
    await nextTurn()

    await handedOff(conversation, 'one')
    await handedOff(conversation, 'two')
    await handedOff(conversation, 'three')

    const underway = await underwayIn(db, conversation)
    expect(underway?.handedOff).toHaveLength(3)
  })

  it('runs them together, which is the whole of why opening a second one is worth anything', async () => {
    // It used to be one at a time: two agents in one directory tread on each other, and the
    // ledger said so. Each of these has a directory of its own now, so what is left to say is
    // how many at once — a number, and one nobody has moved off its default here.
    const conversation = await handedOver()
    await nextTurn()
    const first = await handedOff(conversation, 'one')
    const second = await handedOff(conversation, 'two')

    const took = [await nextTurn(), await nextTurn()]

    expect(new Set(took)).toEqual(new Set([first.conversationId, second.conversationId]))
  })

  it('lets it go when the machine it handed to stops answering, or it waits for ever', async () => {
    // The one way a piece of work can be stuck with nothing anywhere to say so: the machine it
    // handed to never comes back, and "still open" is true for the rest of time.
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)
    await ends(conversation, '1/end')
    expect(await nextTurn()).toBe(off.conversationId)
    expect(await nextTurn()).toBeUndefined()

    await wentSilent(MACHINE)

    expect(await nextTurn()).toBe(conversation)
  })

  it('says why, once, however many instances are asking', async () => {
    // Let go without being told is an agent that wakes for no reason it can see. And every
    // instance runs the same look every ten seconds — the line has to be written exactly once.
    const conversation = await handedOver()
    await nextTurn()
    await handedOff(conversation, 'add an integration test')
    await ends(conversation, '1/end')
    await wentSilent(MACHINE)

    // Not the count it returns — that is every parent on this deployment, and the other tests
    // here leave plenty. What has to be exactly once is the line in *this* conversation.
    await tellWhoeverIsWaitingOnAGoneMachine(db)
    const once = await heard(conversation)
    await tellWhoeverIsWaitingOnAGoneMachine(db)

    expect(once).toContain('mina-mbp')
    expect(once).toContain('add an integration test')
    expect(await heard(conversation)).toBe(once)
  })

  it('starts again as soon as one of them comes back, with what it said', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)
    await ends(conversation, '1/end')

    await stopsWorking(db, reporting(off.conversationId, 'fin'), {
      state: 'done',
      ending: 'done',
      said: 'on branch sub/xxx',
    })

    expect(await nextTurn()).toBe(conversation)
    const read = await db
      .selectFrom('messages')
      .select('content')
      .where('conversation_id', '=', conversation)
      .where('role', '=', 'activity')
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst()
    expect(read?.content).toMatchObject({
      activityType: ACTIVITY.handedBack,
      text: 'on branch sub/xxx',
    })
  })

  it('wakes the one that handed it out when it asks, or both wait for ever', async () => {
    // The deadlock. Its owner is an agent, not a person — so an Inbox never shows it, and if
    // nobody hands that agent another turn, the two of them wait for each other with nothing
    // anywhere to say so. Stopping and telling whoever was waiting are one rule for this reason.
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)
    await ends(conversation, '1/end')
    expect(await nextTurn()).toBe(off.conversationId)
    expect(await nextTurn()).toBeUndefined()

    await stopsWorking(
      db,
      reporting(off.conversationId, 'asked'),
      asking('which package should it go in?'),
    )

    expect(await nextTurn()).toBe(conversation)
  })

  it('does not wake it for going to sleep, which is not something to read', async () => {
    // Whoever is waiting is waiting for it to be over, and it is not over. They are counting its
    // open children either way, so there is nothing to tell and nothing to clear.
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)
    await ends(conversation, '1/end')
    await nextTurn()

    await stopsWorking(db, reporting(off.conversationId, 'zz'), {
      state: 'sleep',
      until: new Date(Date.now() + 60_000),
    })

    expect(await nextTurn()).toBeUndefined()
  })

  it('does not put what it asks in anybody Inbox — it is asking whoever handed it out', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const off = await handedOff(conversation)

    await stopsWorking(db, reporting(off.conversationId, 'asked'), asking('which package?'))

    expect(await waitingOn(db, PERSON)).toEqual([])
  })

  it('refuses an agent this machine does not have', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await checkIn(db, MACHINE, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.231' }],
    })

    const nowhere = await handOffTo(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'off-1',
      agentKind: 'codex',
      goal: 'anything',
    })

    expect(nowhere).toEqual({ kind: 'no-agent' })
  })

  it('cannot be written a third level even by something that is not this code', async () => {
    // `handOffTo` refusing covers what this build writes and nothing else. Rows written before
    // two levels were the rule were allowed any depth, and `takeBack` no longer walks a tree —
    // so a grandchild it cannot see is work still running after the person who could stop it
    // already stopped the parent. Said as a key, it is not something anybody has to remember.
    const conversation = await handedOver()
    await nextTurn()
    const child = await handedOff(conversation)
    const its = await db
      .selectFrom('tasks')
      .select('id')
      .where('conversation_id', '=', child.conversationId)
      .executeTakeFirstOrThrow()
    const deeper = await opened('somewhere to hang it')

    await expect(
      db
        .insertInto('tasks')
        .values({
          conversation_id: deeper,
          parent_id: its.id,
          owner_user_id: PERSON,
          goal: 'run it on the big box',
          state: 'working',
        })
        .execute(),
    ).rejects.toThrow(/tasks_no_grandchildren/u)
  })

  it('refuses when it is itself a sub-task, because that is where the fanning out stops', async () => {
    // `prd.md` 07 ⑤. A plan that fans out belongs with whoever has to answer for it — three deep,
    // no person ever chose the shape of it, and taking the top one back stops work nobody can
    // name. Two levels also make "everything under this" one index seek rather than a walk.
    const conversation = await handedOver()
    await nextTurn()
    const child = await handedOff(conversation)

    const deeper = await handOffTo(db, {
      conversationId: child.conversationId,
      machineId: MACHINE,
      key: 'off-deeper',
      agentKind: 'codex',
      goal: 'run it on the big box',
    })

    expect(deeper).toEqual({ kind: 'not-yours-to-hand-off' })
  })
})

describe('a report that arrives twice', () => {
  it('does not undo the answer a person gave between the two', async () => {
    // The response to the first was lost, so the agent sends it again. In between, a person read
    // the question in their Inbox and answered it. Replayed, the work goes back to waiting with
    // the answer already given and nobody holding it — and nothing anywhere says so.
    const conversation = await handedOver()
    await nextTurn()
    const asked = { conversationId: conversation, machineId: MACHINE, key: 'turn-1/ask' }
    await stopsWorking(db, asked, { state: 'wait', question: 'which database?' })
    await asks(conversation, 'answer-1', 'the staging one')
    expect((await underwayIn(db, conversation))?.task.state).toBe('working')

    await stopsWorking(db, asked, { state: 'wait', question: 'which database?' })

    expect((await underwayIn(db, conversation))?.task.state).toBe('working')
  })

  it('does not end the turn that is running now with an ending meant for an older one', async () => {
    // Same lost response, on the plainest path there is. The key names the turn it was written
    // for; what `openTurn` finds is whichever turn is open — by then, a different question that
    // is still being answered.
    const conversation = await opened()
    await asks(conversation, 'turn-1', 'where does the timeout live?')
    await nextTurn()
    await ends(conversation, 'turn-1/end')
    await asks(conversation, 'turn-2', 'and the retry count?')
    const second = await nextTurn()
    expect(second).toBe(conversation)

    await ends(conversation, 'turn-1/end')

    // Still open: the machine is answering it, and nothing about the retry says otherwise.
    expect(
      await db.transaction().execute(async (tx) => openTurn(tx, conversation)),
    ).not.toBeUndefined()
  })
})

describe('a machine that was taken away mid-flight', () => {
  it('cannot move the work, however far into the request it had got', async () => {
    // Its credential is refused at the door from the next call on. This is the call already
    // inside: the middleware let it through before the removal committed, and what it does next
    // is a write with a credential its owner has just taken away.
    const conversation = await handedOver()
    await nextTurn()
    await removeMachine(db, { machine: MACHINE, owner: PERSON })

    const said = await stopsWorking(
      db,
      { conversationId: conversation, machineId: MACHINE, key: 'gone/done' },
      { state: 'done', ending: 'done', said: 'all finished' },
    )

    expect(said).toEqual({ kind: 'nothing-to-report' })
    expect((await underwayIn(db, conversation))?.task.state).toBe('working')
  })
})

describe('a turn nobody was watching', () => {
  it('stops the work as well, or the next look hands it straight back out', async () => {
    // `unknown` means the turn may already have done everything it was asked. Left `working`, the
    // very next look gives the agent another turn and it does that work again — the one thing
    // this state exists to prevent.
    const conversation = await handedOver()
    await nextTurn()

    await forgetStranded(db, MACHINE)

    expect((await underwayIn(db, conversation))?.task.state).toBe('wait')
    expect(await nextTurn()).toBeUndefined()
  })
})

describe('taking it back', () => {
  async function subtask(conversation: string, goal: string): Promise<string> {
    const off = await handOffTo(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: `off-${goal}`,
      agentKind: 'codex',
      goal,
    })
    if (off.kind !== 'handed-off') throw new Error(`could not hand off: ${off.kind}`)
    return off.conversationId
  }

  it('stops every sub-task under it, not only the first', async () => {
    // Each of them is still changing files, and the piece of work that would have read what they
    // came back with is over. Nobody is watching them and nobody wants them — which is what
    // `prd.md` 04 ⑪ says take-back is for.
    //
    // It walked the tree while a tree could be any depth. Two levels is the whole of it now, so
    // what this proves is that "everything under this" still means all of them and not one.
    const conversation = await handedOver()
    await nextTurn()
    const first = await subtask(conversation, 'add an integration test')
    const second = await subtask(conversation, 'update the changelog')

    const back = await takeBack(db, { conversationId: conversation, spaceId: SPACE, key: 'back-2' })

    expect(back).toEqual({ kind: 'taken-back', alsoStopped: 2 })
    expect(await underwayIn(db, first)).toBeUndefined()
    expect(await underwayIn(db, second)).toBeUndefined()
  })

  it('asks the running turn to stop instead of only taking it out of the queue', async () => {
    const conversation = await handedOver()
    await nextTurn()

    await takeBack(db, { conversationId: conversation, spaceId: SPACE, key: 'back-running' })

    expect(await stopsWantedOn(db, MACHINE)).toContainEqual(
      expect.objectContaining({ conversationId: conversation }),
    )
  })

  it('takes back what it handed off as well, so nothing is left running unwatched', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await subtask(conversation, 'add an integration test')

    const back = await takeBack(db, { conversationId: conversation, spaceId: SPACE, key: 'back-1' })

    expect(back).toEqual({ kind: 'taken-back', alsoStopped: 1 })
    expect(await nextTurn()).toBeUndefined()
  })

  it('leaves the conversation usable, as an ordinary one', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await ends(conversation, '1/end')
    await takeBack(db, { conversationId: conversation, spaceId: SPACE, key: 'back-1' })

    await asks(conversation, 'turn-2', 'I will do the rest myself')

    // A turn, because a person asked for one — not because anything is carrying on by itself.
    expect(await nextTurn()).toBe(conversation)
    await ends(conversation, '2/end')
    expect(await nextTurn()).toBeUndefined()
  })

  it('can be handed over a second time once the first is over, as a second piece of work', async () => {
    // A conversation has one piece of work open at a time, and any number of them over its life.
    // The agent still remembers how it did the first — it is the same conversation.
    const conversation = await handedOver('make the timeout configurable')
    await nextTurn()
    await stopsWorking(
      db,
      { conversationId: conversation, machineId: MACHINE, key: 'first/done' },
      { state: 'done', ending: 'done', said: 'changed and tested' },
    )

    const proposalSeq = await proposes(
      conversation,
      `proposal-again-${RUN}`,
      'watch the numbers for three days',
    )
    const again = await handOver(db, {
      conversationId: conversation,
      spaceId: SPACE,
      key: `over-again-${RUN}`,
      userId: PERSON,
      proposalSeq,
    })

    expect(again.kind).toBe('handed-over')
    expect((await underwayIn(db, conversation))?.task.goal).toBe('watch the numbers for three days')
  })

  it('says there is nothing to take back when nothing was handed over', async () => {
    const conversation = await opened()

    expect(await takeBack(db, { conversationId: conversation, spaceId: SPACE, key: 'b' })).toEqual({
      kind: 'nothing-to-take-back',
    })
  })
})

describe('what it writes down on purpose', () => {
  it('keeps one under a title, and writing that title again revises it', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const at = reporting(conversation, 'out-1')

    await writesOutput(db, at, { title: 'Rollout review', body: 'Day one: flat.' })
    await writesOutput(db, at, { title: 'Rollout review', body: 'Day three: up 4%.' })
    await writesOutput(db, at, { title: 'Migration notes', body: 'Two steps.' })

    const standing = await underwayIn(db, conversation)
    expect(standing?.outputs.map((one) => one.title).sort()).toEqual([
      'Migration notes',
      'Rollout review',
    ])
    expect(standing?.outputs.find((one) => one.title === 'Rollout review')?.body).toBe(
      'Day three: up 4%.',
    )
  })
})

describe('putting a goal in front of somebody', () => {
  it('starts from the exact current card rather than a goal repeated by the caller', async () => {
    const conversation = await opened()
    const proposalSeq = await proposes(
      conversation,
      `current-proposal-${RUN}`,
      'make the timeout settable',
    )
    await ends(conversation, `proposal-turn-done-${RUN}`)

    const over = await handOver(db, {
      conversationId: conversation,
      spaceId: SPACE,
      key: `accept-current-${RUN}`,
      userId: PERSON,
      proposalSeq,
    })

    expect(over.kind).toBe('handed-over')
    expect((await underwayIn(db, conversation))?.task.goal).toBe('make the timeout settable')
  })

  it('refuses a card after the person continued talking', async () => {
    const conversation = await opened()
    const proposalSeq = await proposes(conversation, `stale-proposal-${RUN}`, 'delete the database')
    await asks(conversation, `correction-${RUN}`, 'Only clean the test database')

    const over = await handOver(db, {
      conversationId: conversation,
      spaceId: SPACE,
      key: `accept-stale-${RUN}`,
      userId: PERSON,
      proposalSeq,
    })

    expect(over).toEqual({ kind: 'no-current-proposal' })
    expect(await underwayIn(db, conversation)).toBeUndefined()
  })

  it('accepts the replacement card and refuses the one it replaced', async () => {
    const conversation = await opened()
    const oldSeq = await proposes(conversation, `old-proposal-${RUN}`, 'delete the database')
    const currentSeq = await proposes(
      conversation,
      `replacement-proposal-${RUN}`,
      'only clean the test database',
    )

    expect(
      await handOver(db, {
        conversationId: conversation,
        spaceId: SPACE,
        key: `accept-old-${RUN}`,
        userId: PERSON,
        proposalSeq: oldSeq,
      }),
    ).toEqual({ kind: 'no-current-proposal' })

    expect(
      await handOver(db, {
        conversationId: conversation,
        spaceId: SPACE,
        key: `accept-replacement-${RUN}`,
        userId: PERSON,
        proposalSeq: currentSeq,
      }),
    ).toMatchObject({ kind: 'handed-over' })
  })

  it('refuses a transcript line that is not a proposal', async () => {
    const conversation = await opened()

    expect(
      await handOver(db, {
        conversationId: conversation,
        spaceId: SPACE,
        key: `accept-question-${RUN}`,
        userId: PERSON,
        proposalSeq: 1,
      }),
    ).toEqual({ kind: 'no-current-proposal' })
  })

  it('is a message and nothing more until its card is confirmed', async () => {
    // A proposal changes no state and creates nothing: it is a line for a person to read and
    // agree to. So it goes down the path a machine already writes lines by, and this side of the
    // system has no opinion about it at all.
    const conversation = await opened()
    await asks(conversation, 'turn-1', 'take it from here')
    await nextTurn()

    await machineSays(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'new-1',
      message: {
        role: 'activity',
        content: { activityType: ACTIVITY.proposed, text: 'make the timeout settable' },
      },
    })

    expect(await underwayIn(db, conversation)).toBeUndefined()
  })

  it('cannot be said about a piece of work that does not exist yet, and the rest cannot', async () => {
    const conversation = await opened()
    await asks(conversation, 'turn-1', 'hello')
    await nextTurn()

    expect(await stopsWorking(db, reporting(conversation, 'a'), asking('A or B?'))).toEqual({
      kind: 'nothing-to-report',
    })
  })
})

describe('the Inbox', () => {
  it('really crosses Spaces, and not only in a double that says so', async () => {
    // The one brake this product has. A piece of work waiting on somebody that is not on this
    // list is one that will never move again — so "every Space" has to be true of the query, not
    // of a fixture that only ever built one Space to look in.
    const here = await handedOver('make the timeout configurable')
    await nextTurn()
    await stopsWorking(db, reporting(here, 'asked-here'), asking('env var, or a field?'))

    const elsewhere = await inAnotherSpace()
    await stopsWorking(db, reporting(elsewhere, 'asked-there'), asking('which region?'))

    const waiting = await waitingOn(db, PERSON)
    expect(waiting.map((one) => one.conversationId).sort()).toEqual([here, elsewhere].sort())
    // And they say which Space each one is in, or the list cannot be clicked through.
    expect(new Set(waiting.map((one) => one.spaceSlug)).size).toBe(2)
  })

  it('has what stopped on this person, with what it asked', async () => {
    const conversation = await handedOver('make the timeout configurable')
    await nextTurn()
    await stopsWorking(
      db,
      reporting(conversation, 'asked-1'),
      asking('env var, or a field on the client?'),
    )

    expect(await waitingOn(db, PERSON)).toMatchObject([
      { goal: 'make the timeout configurable', asked: 'env var, or a field on the client?' },
    ])
  })

  it('is empty while it is working, and again once they answer', async () => {
    const conversation = await handedOver()
    await nextTurn()
    expect(await waitingOn(db, PERSON)).toEqual([])

    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('A or B?'))
    await ends(conversation, '1/end')
    expect(await waitingOn(db, PERSON)).toHaveLength(1)

    await asks(conversation, 'turn-2', 'A')
    expect(await waitingOn(db, PERSON)).toEqual([])
  })

  it('shows nothing to somebody who is not in that Space', async () => {
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('A or B?'))
    const stranger = await db
      .transaction()
      .execute(async (tx) =>
        arrive(
          tx,
          { kind: 'email', subject: `nobody-${RUN}@example.com` },
          { name: null, username: null, address: `nobody-${RUN}@example.com` },
        ),
      )

    expect(await waitingOn(db, stranger.userId)).toEqual([])
  })
})

describe('a machine taken out between the door and the claim', () => {
  it('is handed no turn, which is what the poll route says happens', async () => {
    // The credential was read in an earlier transaction; removing the machine commits between
    // that and this one. Asked only at the door, this hands one more turn to a laptop nobody can
    // reach — and the comment above the poll handler says it cannot.
    const conversation = await opened()
    await asks(conversation, 'turn-1', 'where does the timeout live?')
    await removeMachine(db, { machine: MACHINE, owner: PERSON })

    expect(await takeOne(db, MACHINE)).toBeUndefined()
  })
})

describe('what the second person in a Space can see', () => {
  it('is the same conversation and the same piece of work, not only their own', async () => {
    // `prd.md` 05 ② — what somebody who joins sees is what you see. A Space is where these people
    // and these machines work together; work that only its owner could read would make a Space of
    // five people five Spaces of one.
    const rui = await alsoHere()
    const conversation = await handedOver('make the timeout configurable')

    const theirs = await underwayIn(db, conversation)
    const seen = await conversationsIn(db, SPACE, PERSON)

    expect(theirs?.task.goal).toBe('make the timeout configurable')
    expect(seen.map((one) => one.id)).toContain(conversation)
    // And it is not because they own it: it is still the person who handed it over.
    expect(await waitingOn(db, rui)).toEqual([])
  })
})

describe('two people saying something before either is answered', () => {
  it('sends both to the agent, oldest first, each with a name', async () => {
    // Measured before this existed: only the second line was ever sent, and the first sat in the
    // transcript looking queued for ever. `prd.md` 06 「为什么是现在」.
    const rui = await alsoHere()
    const conversation = await opened('where does the timeout live?')
    await sayTo(
      db,
      { conversationId: conversation, spaceId: SPACE, key: 'm-1', saidBy: rui },
      { text: 'and does it affect retries?' },
    )

    const taken = await takeOne(db, MACHINE)

    expect(taken?.asked.map((one) => one.text)).toEqual([
      'where does the timeout live?',
      'and does it affect retries?',
    ])
    expect(new Set(taken?.asked.map((one) => one.who)).size).toBe(2)
  })

  it('does not carry back a question the turn before it already answered', async () => {
    // The bound is what taking one line used to do. Interrupting writes the new question while
    // the turn it interrupted is still ending, and that turn sits between the two.
    const conversation = await opened('where does the timeout live?')
    const first = await takeOne(db, MACHINE)
    await ends(conversation, '1/end')
    await asks(conversation, 'k-2', 'and the retries?')

    const second = await takeOne(db, MACHINE)

    expect(first?.asked.map((one) => one.text)).toEqual(['where does the timeout live?'])
    expect(second?.asked.map((one) => one.text)).toEqual(['and the retries?'])
  })

  it('gives a turn nobody asked for nothing to answer', async () => {
    // Handed over: it carries on by itself, and the line it begins after is the ending of the
    // turn before — which nobody said.
    const conversation = await handedOver()
    await nextTurn()
    await ends(conversation, '1/end')

    expect((await takeOne(db, MACHINE))?.asked).toEqual([])
  })
})

describe('somebody who was taken out of a Space', () => {
  it('still has their name on what they said and what they handed over', async () => {
    // `prd.md` 05 ⑦, and it is true today only because nothing tidies up on removal — which is
    // exactly the kind of true that stops being true the day somebody writes the tidying. Linear
    // and GitHub both keep a removed member's work attributed to them, and the transcript is a
    // record: it says what happened, and what happened does not change.
    const rui = await alsoHere()
    const conversation = await handedOver('make the timeout configurable')
    await handWorkTo(db, { spaceId: SPACE, conversationId: conversation, userId: rui })

    await removes(db, { spaceId: SPACE, userId: rui })

    const task = await db
      .selectFrom('tasks')
      .select('owner_user_id as owner')
      .where('conversation_id', '=', conversation)
      .executeTakeFirstOrThrow()
    const lines = await db
      .selectFrom('messages')
      .select('id')
      .where('conversation_id', '=', conversation)
      .execute()

    expect(task.owner).toBe(rui)
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('handing a piece of work to another person', () => {
  it('puts it in their Inbox and takes it out of yours', async () => {
    // The whole reason it is one column. Whose it is and who is told about it are the same fact,
    // so there is nothing here to keep in step — and nothing that can be moved and not told.
    const rui = await alsoHere()
    const conversation = await handedOver('make the timeout configurable')
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('env var, or a field?'))
    expect(await waitingOn(db, PERSON)).toHaveLength(1)

    expect(
      await handWorkTo(db, { spaceId: SPACE, conversationId: conversation, userId: rui }),
    ).toEqual({ kind: 'moved' })

    expect(await waitingOn(db, PERSON)).toEqual([])
    expect(await waitingOn(db, rui)).toMatchObject([{ conversationId: conversation }])
  })

  it('refuses a piece of work that is in another Space, however good the caller looks', async () => {
    // The path says which Space and the body says which piece of work, and until both are checked
    // *together* an owner of one Space who has seen an id from another can move that other
    // Space's work. Everything about the answer looks right: the caller is an owner here, the
    // person handed to is a member here, one row changed.
    const rui = await alsoHere()
    const elsewhere = await inAnotherSpace()

    expect(
      await handWorkTo(db, { spaceId: SPACE, conversationId: elsewhere, userId: rui }),
    ).toEqual({ kind: 'not-a-member' })

    const still = await db
      .selectFrom('tasks')
      .select('owner_user_id as owner')
      .where('conversation_id', '=', elsewhere)
      .executeTakeFirstOrThrow()
    expect(still.owner).toBe(PERSON)
  })

  it('refuses somebody who is not in this Space, so it cannot be handed out of one', async () => {
    // Otherwise "hand it over" is a way to move a piece of work somewhere nobody here can see it,
    // and the person it was given to cannot reach the Space it lives in.
    const address = `outside-${RUN}@example.com`
    const stranger = await db
      .transaction()
      .execute(async (tx) =>
        arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
      )
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('A or B?'))

    expect(
      await handWorkTo(db, {
        spaceId: SPACE,
        conversationId: conversation,
        userId: stranger.userId,
      }),
    ).toEqual({ kind: 'not-a-member' })
    expect(await waitingOn(db, PERSON)).toHaveLength(1)
  })

  it('refuses somebody who was removed, rather than handing it to a person who cannot see it', async () => {
    const rui = await alsoHere()
    await removes(db, { spaceId: SPACE, userId: rui })
    const conversation = await handedOver()
    await nextTurn()
    await stopsWorking(db, reporting(conversation, 'asked-1'), asking('A or B?'))

    expect(
      await handWorkTo(db, { spaceId: SPACE, conversationId: conversation, userId: rui }),
    ).toEqual({ kind: 'not-a-member' })
  })
})
