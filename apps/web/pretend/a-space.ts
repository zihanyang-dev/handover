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
import { signedIn, SOMEBODY } from '../pretend/signed-in.ts'

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
type Machine = components['schemas']['SpaceMachine']
type Conversation = components['schemas']['Conversation']
type Machines = components['schemas']['Machines']
type Conversations = components['schemas']['Conversations']
type PretendAgent = Omit<Machine['agents'][number], 'avatarUrl' | 'name' | 'atOnce'> & {
  readonly avatarUrl?: string
  readonly name?: string | null
  /** How many at a time, when a test is about that. Nearly none of them are. */
  readonly atOnce?: number
}
type PretendMachine = Omit<Machine, 'agents' | 'ownerUserId' | 'working'> & {
  readonly agents: readonly PretendAgent[]
  /** Whose it is. Defaulted to whoever is signed in, which is what `yours` says on nearly all of them. */
  readonly ownerUserId?: string
  /** Open work is only named by tests about stopping sharing; every other machine carries none. */
  readonly working?: Machine['working']
}
type PretendConversation = Omit<Conversation, 'pinned' | 'startedByYou'> & {
  readonly pinned?: boolean
  /** Whose it is. Defaulted to the person asking, which is what nearly every test's is. */
  readonly startedByYou?: boolean
}

function completeMachine(machine: PretendMachine): Machine {
  return {
    ownerUserId: SOMEBODY,
    working: [],
    ...machine,
    agents: machine.agents.map((agent) => ({
      name: null,
      atOnce: 3,
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
        conversations: conversations.map((conversation) => ({
          pinned: false,
          startedByYou: true,
          ...conversation,
        })),
      }),
    ),
    http.post(
      `*/spaces/${slug}/conversations/:id/typing`,
      () => new HttpResponse(null, { status: 204 }),
    ),
  ]
}
