import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import routing from './tsr.config.json' with { type: 'json' }
import contract from '../server/generated/openapi.json' with { type: 'json' }

/** The API is same-origin in production; in development it is a separate process on its own port. */
const SERVER = process.env['HANDOVER_API_ORIGIN'] ?? 'http://localhost:3000'

/**
 * Paths the API owns, read out of the contract rather than listed by hand.
 *
 * Kept by hand it went stale the first time routes were added: the browser asked this dev server
 * for `/enrolments/…`, got the app's own HTML back, and the page said something vague about not
 * being able to check. Derived, a route that exists is a route that is proxied.
 *
 * `/spaces` being among them is why your Spaces are the front door rather than a page at that
 * address — one path cannot be two things.
 */
const OWNED_BY_SERVER = [
  ...new Set(Object.keys(contract.paths).map((path) => `/${path.split('/')[1] ?? ''}`)),
]

export default defineConfig({
  root: import.meta.dirname,
  // The same file `tsr generate` reads, so a route tree built by the dev server and one built by
  // `pnpm generate` cannot disagree about where routes live.
  plugins: [tanstackRouter(routing), react()],
  server: { proxy: Object.fromEntries(OWNED_BY_SERVER.map((path) => [path, SERVER])) },
})
