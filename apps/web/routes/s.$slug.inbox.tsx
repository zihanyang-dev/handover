import { createFileRoute } from '@tanstack/react-router'
import { Inbox } from '../features/conversations/inbox.tsx'

/**
 * Everything waiting on you, reached from inside a Space and belonging to none of them.
 *
 * It sits in the Space's frame because that is where somebody is when they need it — in the
 * middle of something, wondering what else has stopped. Its rows go wherever the work is, which
 * is often somewhere else entirely.
 */
export const Route = createFileRoute('/s/$slug/inbox')({
  staticData: { where: 'Inbox' },
  component: Inbox,
})
