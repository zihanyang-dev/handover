/**
 * A Space as the screens ask for it: the three calls that page makes, answered together.
 *
 * Typed against the contract for the same reason {@link signedIn} is. Written out per file it had
 * already drifted: the Space screen grew a conversations panel and two of the three copies never
 * learned about it, so every test in one file had been quietly erroring on an unhandled request —
 * passing, because a panel that cannot read its list still renders.
 *
 * A double that can lie about the contract is worse than no double: it makes a screen pass against
 * an answer the server will never give. New decorative identity fields get defaults at this one
 * boundary so tests about another behavior do not each invent an avatar URL.
 */

import { http, HttpResponse } from 'msw'
import type { components } from '../generated/api.ts'
import { signedIn } from '../pretend/signed-in.ts'

/**
 * The faces, which every screen showing a person or an agent asks the browser to fetch.
 *
 * Answered here rather than left unhandled: the suite refuses an unhandled request, and a screen
 * whose `<img>` fell through filled the output of every passing test with the same network error.
 * One pixel is enough — nothing here is about what a face looks like.
 */
function aFace() {
  return http.get('*/avatars/*', () =>
    HttpResponse.text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />', {
      headers: { 'content-type': 'image/svg+xml' },
    }),
  )
}

type Space = components['schemas']['Space']
type Machine = components['schemas']['Machine']
type Conversation = components['schemas']['Conversation']
type Machines = components['schemas']['Machines']
type Conversations = components['schemas']['Conversations']
type PretendAgent = Omit<Machine['agents'][number], 'avatarUrl' | 'name' | 'atOnce' | 'running'> & {
  readonly avatarUrl?: string
  readonly name?: string | null
  /** How many at a time, when a test is about that. Nearly none of them are. */
  readonly atOnce?: number
  readonly running?: number
}
type PretendMachine = Omit<Machine, 'agents'> & { readonly agents: readonly PretendAgent[] }
type PretendConversation = Omit<Conversation, 'pinned'> & { readonly pinned?: boolean }

function completeMachine(machine: PretendMachine): Machine {
  return {
    ...machine,
    agents: machine.agents.map((agent) => ({
      name: null,
      avatarUrl: `/avatars/agents/${machine.id}/${agent.kind}?v=pixel-art-v1`,
      ...agent,
    })),
  }
}

export function theSpace({
  slug = 'acme',
  machines = [],
  conversations = [],
}: {
  readonly slug?: string
  readonly machines?: readonly PretendMachine[]
  readonly conversations?: readonly PretendConversation[]
} = {}) {
  return [
    signedIn(),
    aFace(),
    http.get(`*/spaces/${slug}`, () =>
      HttpResponse.json<Space>({ id: 'a', slug, displayName: 'Acme', emoji: '🏠' }),
    ),
    http.get(`*/spaces/${slug}/machines`, () =>
      HttpResponse.json<Machines>({ machines: machines.map(completeMachine) }),
    ),
    http.get(`*/spaces/${slug}/conversations`, () =>
      HttpResponse.json<Conversations>({
        conversations: conversations.map((conversation) => ({ pinned: false, ...conversation })),
      }),
    ),
  ]
}
