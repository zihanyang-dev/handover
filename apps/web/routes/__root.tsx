import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  type ErrorComponentProps,
} from '@tanstack/react-router'

export type RouterContext = { readonly queryClient: QueryClient }

function Shell() {
  return <Outlet />
}

function Pending() {
  return (
    <main className="home-state">
      <p role="status">Looking…</p>
    </main>
  )
}

function Unexpected({ reset }: ErrorComponentProps) {
  return (
    <main className="home-state">
      <div>
        <h1>Could not open this page</h1>
        <p role="alert">Try again in a moment.</p>
        <button className="button button-secondary" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  )
}

function NotFound() {
  return (
    <main className="home-state">
      <div>
        <h1>This page is not available</h1>
        <Link to="/onboarding">Back to your Spaces</Link>
      </div>
    </main>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Shell,
  pendingComponent: Pending,
  errorComponent: Unexpected,
  notFoundComponent: NotFound,
})
