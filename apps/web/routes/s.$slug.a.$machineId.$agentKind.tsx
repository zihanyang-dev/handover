import { createFileRoute } from '@tanstack/react-router'
import { StartChat } from '../features/conversations/start-chat.tsx'

function Screen() {
  const { slug, machineId, agentKind } = Route.useParams()
  return <StartChat slug={slug} machineId={machineId} agentKind={agentKind} />
}

export const Route = createFileRoute('/s/$slug/a/$machineId/$agentKind')({
  staticData: { where: 'Chat' },
  component: Screen,
})
