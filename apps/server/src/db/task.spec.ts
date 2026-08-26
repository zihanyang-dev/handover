/**
 * A piece of work somebody handed over.
 *
 * What is under test everywhere here is the same question asked two ways: **is this machine owed
 * a turn**, and **who has to do something**. Both are answered from `tasks.state` and never by
 * reading the transcript, which is the one rule this slice exists to hold.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSlug, type Slug } from '@handover/universal'
import { ACTIVITY } from '../conversation/transcript.ts'
import { loadEnv } from '../env.ts'
import { SILENT_FOR_SECONDS } from '../machine/presence.ts'
import { hashSecret, newEnrolmentSecret } from '../machine/secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { connect, type Database } from './connection.ts'
import { handOffTo, machineSays, openConversation, sayTo } from './conversation.ts'
import { approveEnrolment, openEnrolment } from './enrolment.ts'
import { checkIn, collectEnrolment } from './machine.ts'
import { createSpace } from './space.ts'
import {
  handOver,
  stopsWorking,
  tellWhoeverIsWaitingOnAGoneMachine,
  underwayIn,
  takeBack,
  waitingOn,
  wakeWhoseTimeHasCome,
  writesOutput,
} from './task.ts'
import { takeOne } from './turn.ts'
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
    slug: normalizeSlug(name) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
  SPACE = made.space.id

  MACHINE = await attached('mina-mbp')
})

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
    found: [
      { kind: 'claude-code', version: '2.1.231' },
      { kind: 'codex', version: '0.148.0' },
    ],
  })
  return collected.machineId
}

/** A machine that stopped answering: silent for longer than anybody waits before calling it gone. */
async function wentSilent(machineName: string): Promise<void> {
  await db
    .updateTable('machines')
    .set({ last_seen_at: sql<Date>`now() - ${SILENT_FOR_SECONDS + 60} * interval '1 second'` })
    .where('name', '=', machineName)
    .execute()
}

/** Everything written into a conversation, as one string to look for words in. */
async function heard(conversationId: string): Promise<string> {
  const said = await db
    .selectFrom('messages')
    .select('content')
    .where('conversation_id', '=', conversationId)
    .execute()

  return JSON.stringify(said)
}

async function opened(machineId = MACHINE): Promise<string> {
  const conversation = await openConversation(db, {
    spaceId: SPACE,
    machineId,
    agentKind: 'claude-code',
  })
  if (conversation.kind !== 'opened') throw new Error('the fixture could not open a conversation')
  return conversation.conversationId
}

/** Somebody says something, and the machine takes the turn it is owed. */
async function asks(conversationId: string, key: string, text: string): Promise<void> {
  const said = await sayTo(db, { conversationId, spaceId: SPACE, key }, { text })
  if (said.kind !== 'said') throw new Error(`the fixture could not ask: ${said.kind}`)
}

/** Handed over, and the first turn taken — where every one of these tests starts. */
async function handedOver(goal = 'make the timeout configurable'): Promise<string> {
  const conversation = await opened()
  await asks(conversation, 'turn-1', 'take it from here')

  const over = await handOver(db, {
    conversationId: conversation,
    spaceId: SPACE,
    key: `over-${RUN}`,
    userId: PERSON,
    goal,
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
      goal: 'something else',
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
  async function handedOff(conversation: string, to: string, goal = 'add an integration test') {
    const off = await handOffTo(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: `off-${goal}`,
      machine: to,
      agentKind: 'codex',
      goal,
    })
    if (off.kind !== 'handed-off') throw new Error(`could not hand off: ${off.kind}`)
    return off
  }

  it('opens a conversation of its own, on the machine it names', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const other = await attached('build-server-1')

    const off = await handedOff(conversation, 'build-server-1')

    expect(off.conversationId).not.toBe(conversation)
    expect(await nextTurn(other)).toBe(off.conversationId)
  })

  it('means the same machine every time when two of them share a name', async () => {
    // Names are not identities — two laptops can both be called `mbp`, and in a Space with two
    // people in it they easily are. Whichever one it means, it has to mean that one every time,
    // rather than whichever row the database happened to return first.
    const conversation = await handedOver()
    await nextTurn()
    const first = await attached('mbp')
    await attached('mbp')

    const off = await handedOff(conversation, 'mbp')

    expect(await nextTurn(first)).toBe(off.conversationId)
  })

  it('does not stop the one handing off, so it can open a second', async () => {
    // Blocking on the first would make parallel impossible: it never gets to say the second one.
    const conversation = await handedOver()
    await nextTurn()
    await attached('build-server-1')

    await handedOff(conversation, 'build-server-1', 'one')
    await handedOff(conversation, 'build-server-1', 'two')

    expect(await underwayIn(db, conversation)).toMatchObject({ handedOff: [{ goal: 'one' }, {}] })
  })

  it('stops it once its own turn ends, for as long as any of them are open', async () => {
    // Not a state it declares — the count of its open children, which cannot go stale.
    const conversation = await handedOver()
    await nextTurn()
    await attached('build-server-1')
    await handedOff(conversation, 'build-server-1')
    await ends(conversation, '1/end')

    expect(await nextTurn()).toBeUndefined()
  })

  it('lets it go when the machine it handed to stops answering, or it waits for ever', async () => {
    // The one way a piece of work can be stuck with nothing anywhere to say so: the machine it
    // handed to never comes back, and "still open" is true for the rest of time.
    const conversation = await handedOver()
    await nextTurn()
    await attached('build-server-1')
    await handedOff(conversation, 'build-server-1')
    await ends(conversation, '1/end')
    expect(await nextTurn()).toBeUndefined()

    await wentSilent('build-server-1')

    expect(await nextTurn()).toBe(conversation)
  })

  it('says why, once, however many instances are asking', async () => {
    // Let go without being told is an agent that wakes for no reason it can see. And every
    // instance runs the same look every ten seconds — the line has to be written exactly once.
    const conversation = await handedOver()
    await nextTurn()
    await attached('build-server-1')
    await handedOff(conversation, 'build-server-1', 'add an integration test')
    await ends(conversation, '1/end')
    await wentSilent('build-server-1')

    // Not the count it returns — that is every parent on this deployment, and the other tests
    // here leave plenty. What has to be exactly once is the line in *this* conversation.
    await tellWhoeverIsWaitingOnAGoneMachine(db)
    const once = await heard(conversation)
    await tellWhoeverIsWaitingOnAGoneMachine(db)

    expect(once).toContain('build-server-1')
    expect(once).toContain('add an integration test')
    expect(await heard(conversation)).toBe(once)
  })

  it('starts again as soon as one of them comes back, with what it said', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const other = await attached('build-server-1')
    const off = await handedOff(conversation, 'build-server-1')
    await ends(conversation, '1/end')

    await stopsWorking(db, reporting(off.conversationId, 'fin', other), {
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
    const other = await attached('build-server-1')
    const off = await handedOff(conversation, 'build-server-1')
    await ends(conversation, '1/end')
    expect(await nextTurn()).toBeUndefined()

    await stopsWorking(
      db,
      reporting(off.conversationId, 'asked', other),
      asking('which package should it go in?'),
    )

    expect(await nextTurn()).toBe(conversation)
  })

  it('does not wake it for going to sleep, which is not something to read', async () => {
    // Whoever is waiting is waiting for it to be over, and it is not over. They are counting its
    // open children either way, so there is nothing to tell and nothing to clear.
    const conversation = await handedOver()
    await nextTurn()
    const other = await attached('build-server-1')
    const off = await handedOff(conversation, 'build-server-1')
    await ends(conversation, '1/end')

    await stopsWorking(db, reporting(off.conversationId, 'zz', other), {
      state: 'sleep',
      until: new Date(Date.now() + 60_000),
    })

    expect(await nextTurn()).toBeUndefined()
  })

  it('does not put what it asks in anybody Inbox — it is asking whoever handed it out', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const other = await attached('build-server-1')
    const off = await handedOff(conversation, 'build-server-1')

    await stopsWorking(db, reporting(off.conversationId, 'asked', other), asking('which package?'))

    expect(await waitingOn(db, PERSON)).toEqual([])
  })

  it('refuses a machine that is not in this Space, and one without that agent', async () => {
    const conversation = await handedOver()
    await nextTurn()

    const nowhere = await handOffTo(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'off-1',
      machine: 'somebody-elses-laptop',
      agentKind: 'codex',
      goal: 'anything',
    })

    expect(nowhere).toEqual({ kind: 'no-machine' })
  })
})

describe('taking it back', () => {
  it('takes back what it handed off as well, so nothing is left running unwatched', async () => {
    const conversation = await handedOver()
    await nextTurn()
    const other = await attached('build-server-1')
    const off = await handOffTo(db, {
      conversationId: conversation,
      machineId: MACHINE,
      key: 'off-1',
      machine: 'build-server-1',
      agentKind: 'codex',
      goal: 'add an integration test',
    })
    if (off.kind !== 'handed-off') throw new Error('could not hand off')

    const back = await takeBack(db, { conversationId: conversation, spaceId: SPACE, key: 'back-1' })

    expect(back).toEqual({ kind: 'taken-back', alsoStopped: 1 })
    expect(await nextTurn()).toBeUndefined()
    expect(await nextTurn(other)).toBeUndefined()
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
  it('is a message and nothing more — nothing here has to know about it', async () => {
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
