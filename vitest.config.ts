import { defineConfig } from 'vitest/config'

// The test database is defined by compose.yml, so .env.test is committed and needs no setup.
process.loadEnvFile('.env.test')

export default defineConfig({
  test: {
    projects: [
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
          // The one browser API happy-dom does not have, and the live half of a conversation is
          // exactly what a screen test should be able to see.
          setupFiles: ['./apps/web/event-source.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['apps/server/src/db/**/*.spec.ts', 'apps/server/src/server/**/*.spec.ts'],
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
