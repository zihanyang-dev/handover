import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'react-bootstrap-icons'
import { Credentials } from '../features/identity/credentials.tsx'
import { DisplayName } from '../features/identity/display-name.tsx'
import { SignOut } from '../features/identity/sign-out.tsx'
import { onlySignedIn } from '../features/identity/only-signed-in.ts'

/**
 * The account, which belongs to a person rather than to a Space.
 *
 * On its own address for that reason: everything under `/s/…` is shown in a Space's frame, and
 * putting what is true of somebody everywhere inside one of them would say it is a Space's.
 */
function Screen() {
  return (
    <main className="sheet">
      <section className="card stack">
        <Link className="settings-back" to="/onboarding">
          <ArrowLeft aria-hidden /> Your Spaces
        </Link>
        <h1>Account</h1>
        <DisplayName />
        <Credentials />
        <SignOut />
      </section>
    </main>
  )
}

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ location }) => onlySignedIn(location),
  component: Screen,
})
