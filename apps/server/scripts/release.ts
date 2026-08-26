/**
 * What one release does to the database before the new build starts serving.
 *
 * Separate from `migrate.ts` because they are different jobs on different machines: that one
 * starts a container and writes a schema dump for review, and neither belongs anywhere near a
 * deploy. This one applies the committed migrations to whatever `DATABASE_URL` names and stops.
 *
 * The whole environment is parsed, not just the URL. This runs in the image that is about to
 * serve, with the environment it is about to serve with — so a deployment missing `AUTH_SECRET`
 * fails here, before anything is running, rather than at the first person who tries to sign in.
 */

import { loadEnv } from '../src/env.ts'
import { applyMigrations } from './migrate.ts'

const env = loadEnv()
applyMigrations(env.DATABASE_URL)
