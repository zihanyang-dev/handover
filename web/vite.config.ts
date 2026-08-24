import { join } from 'node:path'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import routing from '../tsr.config.json' with { type: 'json' }

const repo = join(import.meta.dirname, '..')

/** The API is same-origin in production; in development it is a separate process on its own port. */
const SERVER = 'http://localhost:3000'
// Paths the API owns. `/spaces` is among them, which is why your Spaces are the front door
// rather than a page at that address — one path cannot be two things.
const OWNED_BY_SERVER = ['/auth', '/me', '/spaces', '/browser']

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    // The same file `tsr generate` reads, so `pnpm generate` and `pnpm web` cannot disagree about
    // where routes live. Its paths are written from the repository root, which is where `tsr`
    // runs from; Vite's root is `web/`, so they are resolved here rather than restated.
    tanstackRouter({
      ...routing,
      routesDirectory: join(repo, routing.routesDirectory),
      generatedRouteTree: join(repo, routing.generatedRouteTree),
    }),
    react(),
  ],
  server: { proxy: Object.fromEntries(OWNED_BY_SERVER.map((path) => [path, SERVER])) },
})
