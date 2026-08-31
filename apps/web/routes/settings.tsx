import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'react-bootstrap-icons'
import { AccountSettings } from '../features/identity/account.tsx'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'

/** The same account surface when no particular Space is open. */
function Screen() {
  return (
    <main className="min-h-dvh bg-surface p-6 max-sm:p-0">
      <section className="mx-auto min-h-[calc(100dvh-48px)] w-full max-w-230 rounded-xl bg-white px-15 pt-8 pb-16 shadow-(--surface-raised-shadow) max-sm:min-h-dvh max-sm:rounded-none max-sm:px-5">
        <Link
          className="mb-6 inline-flex h-7 items-center gap-1 rounded-md px-1 text-copy-xs leading-5 text-ink-muted no-underline hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
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
