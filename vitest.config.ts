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
        test: {
          name: 'db',
          include: ['src/db/**/*.spec.ts', 'src/server/**/*.spec.ts'],
          setupFiles: ['./vitest.setup-db.ts'],
        },
      },
    ],
  },
})
