/**
 * Stored avatars as same-origin browser images.
 *
 * These routes are open on purpose. The bytes are synthetic, carry no name and no address, and
 * appear beside names on screens a signed-in person may already read. Asking for a session here
 * would make a private browser cache and every future image proxy carry identity for no gain, and
 * an unguessable user or machine id is not treated as a secret anywhere else in the contract.
 */

import { z } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import { avatarFor, avatarKey, type AvatarSubject } from '../avatar.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import type { ObjectStore } from '../object-store.ts'
import { anyone, rowId, sends } from './route.ts'

export type AvatarApi = { readonly objects: ObjectStore }

/**
 * An image rather than JSON, which is the one place in this API that is true.
 *
 * A browser asks for it with an `<img>`, so it has to be the bytes themselves: a JSON envelope
 * would mean a page fetching, decoding and handing the result to a blob URL, and losing the
 * browser's own cache on the way.
 */
const SVG = sends(z.string(), 'The avatar stored under this identity, drawn once and kept')

const svg = {
  ...SVG,
  content: { 'image/svg+xml': { schema: z.string() } },
}

export function avatarApi(deps: AvatarApi) {
  return [personAvatar(deps), agentAvatar(deps)]
}

/** A person's face. */
function personAvatar({ objects }: AvatarApi) {
  return anyone().get('/avatars/users/{userId}', {
    summary: 'A person’s stored avatar',
    params: { userId: rowId },
    answers: { 200: svg, 304: 'The browser already has this one, and it can never change' },

    run: async (c) => shows(c, objects, { kind: 'user', userId: c.req.valid('param').userId }),
  })
}

/** One installed agent's face. Its machine is part of it: two Codexes in a Space are two faces. */
function agentAvatar({ objects }: AvatarApi) {
  return anyone().get('/avatars/agents/{machineId}/{agentKind}', {
    summary: 'An installed agent’s stored avatar',
    params: { machineId: rowId, agentKind: z.enum(AGENT_KIND_NAMES) },
    answers: { 200: svg, 304: 'The browser already has this one, and it can never change' },

    run: async (c) => {
      const { machineId, agentKind } = c.req.valid('param')

      return shows(c, objects, { kind: 'agent', machineId, agentKind })
    },
  })
}

/**
 * The key is the validator, because every key is versioned and every version is immutable.
 *
 * Hashing the bytes would spend work to say again what the key already says. A change of style is
 * a new key, and therefore a new address and a new tag at the same moment.
 */
async function shows<E extends Env>(c: Context<E>, objects: ObjectStore, subject: AvatarSubject) {
  const tag = `"${avatarKey(subject)}"`
  if (c.req.header('if-none-match') === tag) return c.body(null, 304)

  return c.body(await avatarFor(objects, subject), 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
    etag: tag,
  })
}
