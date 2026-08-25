/**
 * The one query cache this app has.
 *
 * Shared with the router's guards rather than left inside the provider, so that what a guard reads
 * on the way in is what the screen behind it renders from. Two caches, or a guard that reads and
 * throws away, means every protected screen asks who is signed in twice — and shows its empty
 * state during the second ask.
 */

import { QueryClient } from '@tanstack/react-query'

export const cache = new QueryClient()
