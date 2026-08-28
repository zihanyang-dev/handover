import { createFileRoute } from '@tanstack/react-router'

/** The deliberately quiet Home screen while its next contents are being designed. */
function Screen() {
  return null
}

export const Route = createFileRoute('/s/$slug/')({
  staticData: { where: 'Home' },
  component: Screen,
})
