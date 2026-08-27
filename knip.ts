/**
 * What is in the repository that nothing reaches.
 *
 * A rule, not a report: an export nobody imports is a promise to callers who do not exist, and a
 * file nothing reaches is a file that will be read, believed, and maintained forever. Both are
 * cheap to leave and expensive to find by hand — this runs in `pnpm check`, so neither survives a
 * commit.
 *
 * Everything here is a fact knip cannot see for itself. Nothing here is an exemption: a finding
 * gets fixed or the thing gets deleted, never listed.
 */

import type { KnipConfig } from 'knip'

export default {
  workspaces: {
    // `dbmate` and `kysely-codegen` are spawned from `node_modules/.bin` by scripts, which is not
    // an import.
    'apps/server': {
      entry: ['scripts/*.ts'],
      project: 'src/**/*.ts',
      ignoreDependencies: ['dbmate', 'kysely-codegen'],
    },
    'apps/web': { entry: ['routes/**/*.tsx'], project: '**/*.{ts,tsx}' },
    // `bun` is the thing that builds the binaries, spawned the same way.
    'apps/cli': { entry: ['scripts/*.ts'], project: 'src/**/*.ts', ignoreDependencies: ['bun'] },
    'packages/universal': {},
    // Not a workspace package: Playwright is run from the root against its own config.
    '.': { entry: ['e2e/playwright.config.ts', 'e2e/*.spec.ts'] },
  },
  ignore: ['**/generated/**'],
  vitest: true,
} satisfies KnipConfig
