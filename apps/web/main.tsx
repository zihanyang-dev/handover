/**
 * Where the browser app starts: one router, one query cache, one root.
 *
 * Everything this file does is arrangement — nothing decides anything, and nothing here knows
 * what any screen is for. The routes are generated from `routes/`, so adding a screen is adding
 * a file there and never editing this one.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { cache } from './query-client.ts'
import { routeTree } from './routeTree.gen.ts'

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('root')
if (root === null) throw new Error('the page has no root to render into')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={cache}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
