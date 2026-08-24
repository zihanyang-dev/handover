import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import routing from './tsr.config.json' with { type: 'json' }

/** The API is same-origin in production; in development it is a separate process on its own port. */
const SERVER = 'http://localhost:3000'

// Paths the API owns. `/spaces` is among them, which is why your Spaces are the front door rather
// than a page at that address — one path cannot be two things.
const OWNED_BY_SERVER = ['/auth', '/me', '/spaces', '/browser']

export default defineConfig({
  root: import.meta.dirname,
  // The same file `tsr generate` reads, so a route tree built by the dev server and one built by
  // `pnpm generate` cannot disagree about where routes live.
  plugins: [tanstackRouter(routing), react()],
  server: { proxy: Object.fromEntries(OWNED_BY_SERVER.map((path) => [path, SERVER])) },
})
