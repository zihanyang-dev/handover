import { defineConfig } from 'vitest/config'

// The test database is defined by compose.yml, so .env.test is committed and needs no setup.
process.loadEnvFile('.env.test')

export default defineConfig({
  test: {
    /**
     * What one worker may hold, so that ten of them cannot promise more than this machine has.
     *
     * Node's default old-space limit here is 4 GB, and a worker only approaches it because V8 lets
     * garbage pile up while there is free memory to pile it in — the heap of any one test file in
     * this suite measures between 54 and 113 MB, so what fills the rest is collectable. Left
     * alone, ten workers each drifting towards 4 GB is a promise of forty on a machine with
     * thirty-two, and it is kept by compressing and swapping until nothing else can run.
     *
     * 512 MB is four times the largest file measured. A worker that genuinely needs more than that
     * has a leak worth finding rather than a limit worth raising.
     */
    poolOptions: { forks: { execArgv: ['--max-old-space-size=512'] } },
    projects: [
      {
        // What the repository asks of itself: not any package's code, and every one of them reads
        // paths from the root because that is what they are about. See `rules/`.
        test: {
          name: 'rules',
          include: ['rules/*.spec.ts'],
          environment: 'happy-dom',
        },
      },
      {
        test: {
          name: 'unit',
          include: [
            'apps/server/src/**/*.spec.ts',
            'apps/cli/src/**/*.spec.ts',
            'packages/**/*.spec.ts',
            './*.spec.ts',
          ],
          exclude: ['apps/server/src/db/**', 'apps/server/src/server/**'],
        },
      },
      {
        // Vitest transforms with esbuild, which does not read the browser tsconfig. Said here so
        // a .tsx test compiles the same way the app does.
        esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
        test: {
          name: 'web',
          include: ['apps/web/**/*.spec.tsx', 'apps/web/**/*.spec.ts'],
          environment: 'happy-dom',
          // happy-dom has no `EventSource`, and a screen that watches one would render nothing of
          // the live half at all. Said for the whole project rather than imported by the tests
          // that happen to need it: what is missing belongs to the environment.
          setupFiles: ['apps/web/pretend/event-source.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['apps/server/src/db/**/*.spec.ts', 'apps/server/src/server/**/*.spec.ts'],
        },
      },
      {
        // Real agents, on this machine, spending real model calls. Asked for by name rather than
        // run by `pnpm check`: CI has neither binary and neither is signed in there.
        test: {
          name: 'agents',
          include: ['apps/cli/agent-check/*.agents.spec.ts'],
          testTimeout: 300_000,
        },
      },
      {
        // A real init, in a container. Slow to start and worth it: what is claimed is that a
        // service manager accepts the unit and keeps the process up, and neither can be faked.
        test: {
          name: 'service',
          include: ['apps/cli/service-check/*.container.spec.ts'],
          testTimeout: 120_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
})
