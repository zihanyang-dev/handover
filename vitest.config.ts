import { defineConfig } from 'vitest/config'

// The test database is defined by compose.yml, so .env.test is committed and needs no setup.
process.loadEnvFile('.env.test')

export default defineConfig({
  test: {
    // The database tests share one database and each empties it, so files cannot overlap. Set
    // here rather than on that project: inside `projects` it is ignored.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
          exclude: ['src/db/**', 'src/server/**'],
        },
      },
      {
        // Vitest transforms with esbuild, which does not read the browser tsconfig. Said here so
        // a .tsx test compiles the same way the app does.
        esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
        test: {
          name: 'web',
          include: ['web/**/*.spec.tsx', 'web/**/*.spec.ts'],
          environment: 'happy-dom',
          setupFiles: ['./vitest.web-harness.tsx'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['src/db/**/*.spec.ts', 'src/server/**/*.spec.ts'],
          setupFiles: ['./vitest.setup-db.ts'],
        },
      },
    ],
  },
})
