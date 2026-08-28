import { createFileRoute } from '@tanstack/react-router'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'
import { Onboarding } from '../features/onboarding/onboarding.tsx'

/** What a trip through a provider left behind, if it left anything. */
function arrived(search: Record<string, unknown>): { handover_result?: string } {
  const result = search['handover_result']
  return typeof result === 'string' ? { handover_result: result } : {}
}

function Screen() {
  return <Onboarding result={Route.useSearch().handover_result} />
}

export const Route = createFileRoute('/onboarding')({
  validateSearch: arrived,
  beforeLoad: async ({ context, location }) => onlySignedIn(context.queryClient, location),
  component: Screen,
})
