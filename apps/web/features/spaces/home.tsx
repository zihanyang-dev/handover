/**
 * The frame everything inside a Space is shown in.
 *
 * Its sidebar structure, states and motion come from Notion's live app; Handover supplies the
 * identity. One frame rather than one per page: the sidebar, its width, and whether it is open
 * are the same thing on every screen, and a second copy of them is a second answer.
 *
 * What goes in it is the caller's — the sidebar under the tabs, and the main area. This file owns
 * the frame and nothing that lives inside it.
 */

import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Mark } from '../../mark.tsx'
import type { Me } from '../identity/me.ts'
import { CollapseIcon, HomeIcon, MenuIcon, PersonIcon } from './sidebar-icons.tsx'

type Space = Me['spaces'][number]

const DEFAULT_SIDEBAR_WIDTH = 270
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 480

function resizedWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

function beginSidebarResize(
  event: ReactPointerEvent<HTMLDivElement>,
  width: number,
  setWidth: (next: number) => void,
  setResizing: (resizing: boolean) => void,
) {
  event.preventDefault()
  const start = event.clientX
  const move = (pointer: PointerEvent) => {
    setWidth(resizedWidth(width + pointer.clientX - start))
  }
  const finish = () => {
    setResizing(false)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
  }

  setResizing(true)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
}

function WorkspaceMark() {
  return (
    <span className="home-workspace-icon" aria-hidden>
      <Mark size={22} bodyColor="#2c2c2b" />
    </span>
  )
}

function WorkspaceHeader({
  space,
  closeSidebar,
}: {
  readonly space: Space
  readonly closeSidebar: () => void
}) {
  return (
    <div className="home-workspace-root">
      <div className="home-workspace-pill">
        <div className="home-workspace-identity">
          <WorkspaceMark />
          <span className="home-workspace-name">{space.displayName}</span>
        </div>
        <button
          className="home-close-sidebar"
          type="button"
          aria-label="Close sidebar"
          onClick={closeSidebar}
        >
          <CollapseIcon />
        </button>
      </div>
    </div>
  )
}

function ResizeRail({
  width,
  setWidth,
  setResizing,
}: {
  readonly width: number
  readonly setWidth: (next: number) => void
  readonly setResizing: (resizing: boolean) => void
}) {
  return (
    <div className="home-sidebar-resize">
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize with left and right arrow keys"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        onPointerDown={(event) => {
          beginSidebarResize(event, width, setWidth, setResizing)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setWidth(resizedWidth(width - 8))
          if (event.key === 'ArrowRight') setWidth(resizedWidth(width + 8))
        }}
      />
    </div>
  )
}

export function Home({
  space,
  where,
  aside,
  children,
}: {
  readonly space: Space
  /** Where in this Space somebody is, said after its name at the top. */
  readonly where: string
  /** Under the tabs. The list of what is in this Space, whatever that is on this screen. */
  readonly aside?: ReactNode
  readonly children: ReactNode
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [resizing, setResizing] = useState(false)

  return (
    <div
      className="home-shell"
      data-sidebar-open={sidebarOpen}
      data-sidebar-resizing={resizing}
      style={{ '--home-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="home-sidebar-container">
        <aside className="home-sidebar" aria-label={`${space.displayName} sidebar`}>
          <WorkspaceHeader
            space={space}
            closeSidebar={() => {
              setSidebarOpen(false)
            }}
          />

          <nav className="home-tabbar" aria-label="Sidebar navigation">
            <Link
              className="home-tab"
              role="tab"
              aria-selected="true"
              to="/s/$slug"
              params={{ slug: space.slug }}
            >
              <HomeIcon />
              <span>Home</span>
            </Link>
            {/* The way out, from in here rather than only from the Spaces list: somebody who came
                straight to a Space by its address should not have to go somewhere else to leave. */}
            <Link className="home-tab" role="tab" aria-selected="false" to="/settings">
              <PersonIcon />
              <span>Account</span>
            </Link>
          </nav>
          <div className="home-sidebar-panel" role="tabpanel" aria-label="Home">
            {aside}
          </div>
        </aside>

        <ResizeRail width={sidebarWidth} setWidth={setSidebarWidth} setResizing={setResizing} />
      </div>

      <main className="home-main">
        <header className="home-topbar">
          {!sidebarOpen && (
            <button
              className="home-open-sidebar"
              type="button"
              aria-label="Open sidebar"
              onClick={() => {
                setSidebarOpen(true)
              }}
            >
              <MenuIcon />
            </button>
          )}
          <p className="home-breadcrumb">
            <span>{space.displayName}</span>
            <span aria-hidden>/</span>
            <strong>{where}</strong>
          </p>
        </header>

        <section className="home-content" aria-labelledby="home-title">
          <h1 id="home-title">{where}</h1>
          {children}
        </section>
      </main>
    </div>
  )
}
