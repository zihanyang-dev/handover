/**
 * What a browser test needs: a real router, a real query client, and a server that answers.
 *
 * This lives with the test runner rather than under `web/`, because none of it is the product.
 * The requests are intercepted at the network, not by replacing our own client — a test that
 * stubs the module it is testing through proves only that the stub was called.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll } from 'vitest'

export const server = setupServer()

beforeAll(() => {
  // A request nobody stubbed is a test that would have gone to the network. Say so.
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  // Registered here rather than relied on: React Testing Library only wires its own cleanup when
  // vitest globals are on, and a screen left mounted makes the next test find two of everything.
  cleanup()
  server.resetHandlers()
  sessionStorage.clear()
})
afterAll(() => {
  server.close()
})

export type Screen = { readonly path: string; readonly render: () => ReactNode }

/**
 * Mounts screens on a real router at `at`. Navigation is real, so a test can say where a person
 * ended up rather than that a spy was called with a route name.
 */
export function renderAt(at: string, screens: readonly Screen[]): RenderResult {
  const root = createRootRoute()
  const routes = screens.map((screen) =>
    createRoute({
      getParentRoute: () => root,
      path: screen.path,
      component: screen.render,
      validateSearch: (search: Record<string, unknown>) => search,
    }),
  )

  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [at] }),
  })

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      {/* The tree is built per test, so it is not the registered router type. */}
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}
