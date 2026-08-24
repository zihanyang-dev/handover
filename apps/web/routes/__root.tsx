import { createRootRoute, Outlet } from '@tanstack/react-router'

function Shell() {
  return <Outlet />
}

export const Route = createRootRoute({ component: Shell })
