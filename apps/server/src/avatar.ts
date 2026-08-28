/**
 * A stable face for a person or an installed agent.
 *
 * DiceBear is the renderer, not the host. The browser never calls its HTTP API and this process
 * does not redraw a face on every page view: the first missing object is rendered, written under
 * a versioned key, and every later request reads those bytes. Keeping the deterministic seed is
 * still useful — it makes a lost bucket repairable without keeping image bytes in Postgres.
 */

import { Avatar, Style } from '@dicebear/core'
import pixelArt from '@dicebear/styles/pixel-art.json' with { type: 'json' }
import notionists from '@dicebear/styles/notionists-neutral.json' with { type: 'json' }
import type { AgentKind } from './machine/agent-kind.ts'
import type { ObjectStore } from './object-store.ts'

const CONTENT_TYPE = 'image/svg+xml'
const PERSON_KEY_VERSION = 'v1'
const AGENT_KEY_VERSION = 'pixel-art-v1'
const PERSON_STYLE = new Style(notionists)
const AGENT_STYLE = new Style(pixelArt)

export type AvatarSubject =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'agent'; readonly machineId: string; readonly agentKind: AgentKind }

/**
 * No display names in seeds. A rename must not change somebody's face, and a copied bucket must
 * not become another place an address or a person's chosen name is written down.
 *
 * An installed agent includes its machine. Two Codex installations can sit beside each other in
 * one Space; giving both the same face would make the avatar unable to do the identifying asked
 * of it.
 */
function seedFor(subject: AvatarSubject): string {
  if (subject.kind === 'user') return `user:${subject.userId}`
  return `agent:${subject.machineId}:${subject.agentKind}`
}

/** A style change is a new key version, never a mutation under an immutable browser URL. */
export function avatarKey(subject: AvatarSubject): string {
  if (subject.kind === 'user') return `avatars/${PERSON_KEY_VERSION}/users/${subject.userId}.svg`
  return `avatars/${AGENT_KEY_VERSION}/agents/${subject.machineId}/${subject.agentKind}.svg`
}

/**
 * The browser addresses Handover, not the bucket. Moving providers therefore changes neither an
 * API response nor cached markup; only the server-side adapter and copied objects move.
 */
export function avatarPath(subject: AvatarSubject): string {
  if (subject.kind === 'user') return `/avatars/users/${subject.userId}?v=${PERSON_KEY_VERSION}`
  return `/avatars/agents/${subject.machineId}/${subject.agentKind}?v=${AGENT_KEY_VERSION}`
}

function generateAvatar(subject: AvatarSubject): string {
  if (subject.kind === 'agent') {
    return new Avatar(AGENT_STYLE, {
      seed: seedFor(subject),
      size: 128,
    }).toString()
  }

  return new Avatar(PERSON_STYLE, {
    seed: seedFor(subject),
    size: 128,
    backgroundColor: ['#f7f6f3'],
  }).toString()
}

/**
 * Finds the stored face or repairs that one absence.
 *
 * Two first requests may both find nothing. They use the same seed and key, so both write the
 * same bytes and neither can win with a different identity. Any store error is allowed to escape:
 * unreachable is not missing, and answering with a newly generated face would hide that
 * distinction.
 */
export async function avatarFor(objects: ObjectStore, subject: AvatarSubject): Promise<string> {
  const key = avatarKey(subject)
  const stored = await objects.find(key)
  if (stored !== undefined) return new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes)

  const svg = generateAvatar(subject)
  await objects.put(key, { bytes: new TextEncoder().encode(svg), contentType: CONTENT_TYPE })
  return svg
}
