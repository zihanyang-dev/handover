import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'react-bootstrap-icons'
import { AccountSettings } from '../features/identity/account.tsx'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'

/** The same account surface when no particular Space is open. */
function Screen() {
  return (
    <main className="min-h-dvh bg-panel-ground p-6 max-sm:p-0">
      <section className="mx-auto min-h-[calc(100dvh-48px)] w-full max-w-[920px] rounded-[12px] bg-white px-[60px] pt-8 pb-16 shadow-[var(--surface-raised-shadow)] max-sm:min-h-dvh max-sm:rounded-none max-sm:px-5">
        <Link
          className="mb-6 inline-flex h-7 items-center gap-1 rounded-md px-1 text-[14px] leading-5 text-panel-ink-muted no-underline hover:bg-panel-fill hover:text-panel-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          to="/onboarding"
        >
          <ArrowLeft aria-hidden /> Your Spaces
        </Link>
        <AccountSettings />
      </section>
    </main>
  )
}

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ context, location }) => onlySignedIn(context.queryClient, location),
  component: Screen,
})
