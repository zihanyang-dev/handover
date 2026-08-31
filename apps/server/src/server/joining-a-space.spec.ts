/**
 * The doors around a Space with more than one person in it.
 *
 * Mostly refusals, because that is where this can go wrong quietly: a member doing an owner's
 * job, a link that stopped working answering anyway, and somebody who was taken out still being
 * let back through.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'
import { waitingRoom } from '../machine/waiting.ts'
import { credentialApi, type SendCode } from './credential-api.ts'
import { invitationApi } from './invitation-api.ts'
import { machineApi } from './machine-api.ts'
import { memberApi } from './member-api.ts'
import { mounted } from './route.ts'
import { spaceApi } from './space-api.ts'
import { taskApi } from './task-api.ts'

const env = loadEnv()
const db: Database = connect(env)
const WEB = 'http://localhost:5173'

afterAll(async () => {
  await db.destroy()
})

let lastCode = ''

const sendCode: SendCode = async (_to, code) => {
  lastCode = code
  return 'sent'
}

const auth = mounted(
  credentialApi({
    lettersPerCallerPerHour: 500,
    trustedProxyHops: 0,
    db,
    secret: env.AUTH_SECRET,
    sendCode,
    providers: ['google', 'github'],
    webOrigin: WEB,
  }),
)

const spaces = mounted(spaceApi({ db }))
// All four, in one app, exactly as `app.ts` mounts them — the split is by what a route is
// about, and a person joining a Space crosses all of it in one sitting.
const app = mounted([
  ...invitationApi({ db, webOrigin: WEB }),
  ...memberApi({ db }),
  ...taskApi({ db }),
  ...machineApi({ db, waiting: waitingRoom(0) }),
])

let RUN = ''
let KAI = ''
let MINA = ''
let SLUG = ''

beforeEach(async () => {
  RUN = randomUUID()
  KAI = await signedIn(`kai-${RUN}@example.com`)
  MINA = await signedIn(`mina-${RUN}@example.com`)
  SLUG = await aSpace()
})

async function signedIn(email: string): Promise<string> {
  const opened = await auth.request('/auth/email-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, requestKey: `k-${email}` }),
  })
  const { codeId } = (await opened.json()) as { codeId: string }
  const verified = await auth.request('/browser/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeId, code: lastCode }),
  })

  return (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function aSpace(): Promise<string> {
  const made = await spaces.request('/spaces', {
    method: 'POST',
    headers: { cookie: KAI, 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: `Acme ${RUN.slice(0, 8)}`,
      emoji: '🏠',
      requestKey: `s-${RUN}`,
    }),
  })

  return ((await made.json()) as { slug: string }).slug
}

async function as(cookie: string, path: string, method = 'GET', json?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
}

/** A link, and the secret out of it — which is all anybody following one really has. */
async function aLink(): Promise<{ id: string; secret: string }> {
  const made = await as(KAI, `/spaces/${SLUG}/invitations`, 'POST')
  const { id, link } = (await made.json()) as { id: string; link: string }

  return { id, secret: link.split('/join/')[1] ?? '' }
}

async function joined(cookie: string, secret: string): Promise<Response> {
  return as(cookie, '/me/spaces', 'POST', { secret })
}

describe('asking somebody in', () => {
  it('hands back a whole link, because what happens next is sending it to a person', async () => {
    const made = await as(KAI, `/spaces/${SLUG}/invitations`, 'POST')

    expect(made.status).toBe(201)
    expect(((await made.json()) as { link: string }).link).toContain(`${WEB}/join/hi_`)
  })

  it('replaces the previous link and lists only the replacement', async () => {
    const first = await aLink()
    const replacement = await aLink()

    expect((await as(MINA, `/invitations/${first.secret}`)).status).toBe(404)
    expect((await as(MINA, `/invitations/${replacement.secret}`)).status).toBe(200)

    const open = await as(KAI, `/spaces/${SLUG}/invitations`)
    expect((await open.json()) as { invitations: { id: string }[] }).toEqual({
      invitations: [expect.objectContaining({ id: replacement.id })],
    })
  })

  it('is not something a member can do', async () => {
    const { secret } = await aLink()
    await joined(MINA, secret)

    const tried = await as(MINA, `/spaces/${SLUG}/invitations`, 'POST')

    expect(tried.status).toBe(403)
    expect(((await tried.json()) as { recovery: string }).recovery).toBe('ask-an-owner')
  })

  it('says nothing about a Space this person is not in', async () => {
    // Not 403: whether it exists is the thing being hidden, and by here nothing is known.
    const tried = await as(MINA, `/spaces/${SLUG}/invitations`, 'POST')

    expect(tried.status).toBe(404)
  })
})

describe('following a link', () => {
  it('puts them in, and a second click says the same thing', async () => {
    const { secret } = await aLink()

    expect((await joined(MINA, secret)).status).toBe(200)
    expect((await joined(MINA, secret)).status).toBe(200)

    const here = await as(KAI, `/spaces/${SLUG}/members`)
    expect(((await here.json()) as { members: unknown[] }).members).toHaveLength(2)
  })

  it('says which Space it is for, and who asked', async () => {
    const { secret } = await aLink()

    const asked = await as(MINA, `/invitations/${secret}`)

    expect(asked.status).toBe(200)
    expect((await asked.json()) as { slug: string }).toMatchObject({ slug: SLUG })
  })

  it('tells nobody anything without a session', async () => {
    // A link that answered to a stranger would say whether a Space exists to whoever guessed one.
    const { secret } = await aLink()

    expect((await app.request(`/invitations/${secret}`)).status).toBe(401)
  })

  it('stops working once it is revoked, and says the same as one that never was', async () => {
    const { id, secret } = await aLink()

    expect((await as(KAI, `/spaces/${SLUG}/invitations/${id}`, 'DELETE')).status).toBe(204)

    expect((await joined(MINA, secret)).status).toBe(404)
    expect((await joined(MINA, 'hi_never-existed')).status).toBe(404)
  })
})

describe('leaving under your own steam', () => {
  it('is a member’s to do, without having to ask to be thrown out', async () => {
    // Behind an owner-only gate a member cannot leave at all — they have to find somebody and ask
    // to be removed. GitHub lets anybody remove themselves; the only person stopped there is the
    // last owner, and stopped by the rule that a Space keeps one rather than by a permission.
    const { secret } = await aLink()
    await joined(MINA, secret)
    const who = await whoIs(MINA)

    expect((await as(MINA, `/spaces/${SLUG}/members/${who}`, 'DELETE')).status).toBe(204)

    expect((await as(MINA, `/spaces/${SLUG}/members`)).status).toBe(404)
  })

  it('shows a member what is still theirs first, the same as anybody else is shown', async () => {
    const { secret } = await aLink()
    await joined(MINA, secret)
    const who = await whoIs(MINA)

    expect((await as(MINA, `/spaces/${SLUG}/members/${who}/held`)).status).toBe(200)
  })

  it('does not let a member aim it at anybody else', async () => {
    // The gate is about doing things *to other people*, and nothing else about it moved.
    const { secret } = await aLink()
    await joined(MINA, secret)
    const kai = await whoIs(KAI)

    const tried = await as(MINA, `/spaces/${SLUG}/members/${kai}`, 'DELETE')

    expect(tried.status).toBe(403)
    expect((await as(MINA, `/spaces/${SLUG}/members/${kai}/held`)).status).toBe(403)
  })

  it('is not a way to make yourself an owner', async () => {
    // The other half of the same gate, and the half with teeth: leaving is yours to do, and
    // changing what you may do is not. One middleware on the wrong route makes every member an
    // owner, and nothing about the screen would look different.
    const { secret } = await aLink()
    await joined(MINA, secret)
    const who = await whoIs(MINA)

    const tried = await as(MINA, `/spaces/${SLUG}/members/${who}`, 'PATCH', { role: 'owner' })

    expect(tried.status).toBe(403)
  })
})

describe('handing something to another person', () => {
  it('refuses a person who is not in this Space, rather than moving it out of one', async () => {
    const { secret } = await aLink()
    await joined(MINA, secret)

    const tried = await as(KAI, `/spaces/${SLUG}/conversations/${randomUUID()}/task`, 'PATCH', {
      ownerUserId: randomUUID(),
    })

    expect(tried.status).toBe(404)
  })
})

describe('taking somebody out', () => {
  it('stops them reaching the Space at all', async () => {
    const { secret } = await aLink()
    await joined(MINA, secret)
    const who = await whoIs(MINA)

    expect((await as(KAI, `/spaces/${SLUG}/members/${who}`, 'DELETE')).status).toBe(204)

    expect((await as(MINA, `/spaces/${SLUG}/members`)).status).toBe(404)
  })

  it('is refused when it would leave nobody who can let anybody in', async () => {
    const { secret } = await aLink()
    await joined(MINA, secret)
    const kai = await whoIs(KAI)

    const tried = await as(KAI, `/spaces/${SLUG}/members/${kai}`, 'DELETE')

    expect(tried.status).toBe(409)
    expect(((await tried.json()) as { reason: string }).reason).toBe('the-last-owner')
  })

  it('shows what is still theirs before anybody presses it', async () => {
    const { secret } = await aLink()
    await joined(MINA, secret)
    const who = await whoIs(MINA)

    const held = await as(KAI, `/spaces/${SLUG}/members/${who}/held`)

    expect(held.status).toBe(200)
    expect(await held.json()).toEqual({ working: [], machines: [] })
  })
})

/** Which row in `members` is this cookie, which is the only way a test knows somebody's id. */
async function whoIs(cookie: string): Promise<string> {
  const here = await as(KAI, `/spaces/${SLUG}/members`)
  const { members } = (await here.json()) as { members: { userId: string; you: boolean }[] }
  const mine = await as(cookie, `/spaces/${SLUG}/members`)
  const theirs = (await mine.json()) as { members: { userId: string; you: boolean }[] }
  void members

  return theirs.members.find((one) => one.you)?.userId ?? ''
}
