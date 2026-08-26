import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../api.ts'
import { Arrival } from '../features/identity/arrival.tsx'
import { DisplayName } from '../features/identity/display-name.tsx'
import { Credentials } from '../features/identity/credentials.tsx'
import { NewSpace } from '../features/spaces/new-space.tsx'
import { SpaceList } from '../features/spaces/space-list.tsx'
import { Inbox } from '../features/conversations/inbox.tsx'
import { SignOut } from '../features/identity/sign-out.tsx'

/** What a trip through a provider left behind, if it left anything. */
function arrived(search: Record<string, unknown>): { handover_result?: string } {
  const result = search['handover_result']
  return typeof result === 'string' ? { handover_result: result } : {}
}

/**
 * A trip through a provider ends back here with a word about how it went. The words live in
 * arrival.tsx: onboarding hears them too, when sign-in was the trip.
 */
function Screen() {
  const { handover_result: result } = Route.useSearch()

  return (
    <div className="page">
      <Arrival result={result} />

      {/* Before the Spaces, because it is the one thing on this page that is about right now.
          Everything else here is somewhere to go; this is somebody being asked for something. */}
      <Inbox />
      <SpaceList />
      <NewSpace />
      <Credentials />
      <DisplayName />
      <SignOut />
    </div>
  )
}

export const Route = createFileRoute('/')({
  validateSearch: arrived,
  beforeLoad: async ({ context, location }) => {
    await onlySignedIn(location)
    return context
  },
  component: Screen,
})
