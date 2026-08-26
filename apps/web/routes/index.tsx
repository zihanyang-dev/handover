import { createFileRoute, redirect } from '@tanstack/react-router'

/** What a trip through a provider left behind, if it left anything. */
function arrived(search: Record<string, unknown>): { handover_result?: string } {
  const result = search['handover_result']
  return typeof result === 'string' ? { handover_result: result } : {}
}

/**
 * The front door is where somebody picks a Space, so this address only points at it.
 *
 * Nothing is rendered here. A page that listed Spaces *and* offered to make one *and* held the
 * account settings was three screens stacked on one address, and onboarding already asks the one
 * question this moment has: which Space. Whatever a trip through a provider left behind travels
 * with the redirect, because that word is about the person and not about this address.
 */
export const Route = createFileRoute('/')({
  validateSearch: arrived,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/onboarding', search })
  },
})
