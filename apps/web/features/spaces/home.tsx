/**
 * The frame everything inside a Space is shown in.
 *
 * Its sidebar structure, states and motion come from Notion's live app; Handover supplies the
 * identity. One frame rather than one per page: the sidebar, its width, and whether it is open
 * are the same thing on every screen, and a second copy of them is a second answer.
 *
 * What goes in the main area is the caller's. This file owns the frame and nothing that lives
 * inside it.
 */

import { Link, useMatches, useNavigate } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { ChatSidebar, PinnedChats } from '../conversations/chat-sidebar.tsx'
import type { Me } from '../identity/me.ts'
import { ChatIcon, CollapseIcon, HomeIcon, InboxIcon, MenuIcon } from './sidebar-icons.tsx'
import { WorkspaceMenu } from './workspace-menu.tsx'
import { WorkspaceSettings } from './workspace-settings.tsx'

type Space = Me['spaces'][number]
type SidebarView = 'home' | 'chat' | 'inbox'

const DEFAULT_SIDEBAR_WIDTH = 270
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 480

/** The deepest screen names itself; the frame has no list of the screens it can hold. */
function useDeepest(): string {
  const said = useMatches()
    .map((match) => (match.staticData as { where?: string }).where)
    .filter((one) => one !== undefined)

  return said.at(-1) ?? 'Home'
}

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

function useWorkspaceMenu() {
  const [isOpen, setIsOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return undefined
    const closeFromOutside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return
      setIsOpen(false)
    }
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The frame also owns Escape for closing the whole sidebar. One press closes the deepest
      // thing that is open; without this, the menu and the sidebar disappear together.
      event.stopImmediatePropagation()
      setIsOpen(false)
      trigger.current?.focus()
    }

    document.addEventListener('pointerdown', closeFromOutside)
    document.addEventListener('keydown', closeFromKeyboard)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside)
      document.removeEventListener('keydown', closeFromKeyboard)
    }
  }, [isOpen])

  return { isOpen, setIsOpen, root, trigger }
}

function WorkspaceHeader({
  space,
  closeSidebar,
  closeButton,
}: {
  readonly space: Space
  readonly closeSidebar: () => void
  readonly closeButton: RefObject<HTMLButtonElement | null>
}) {
  const { isOpen, setIsOpen, root, trigger } = useWorkspaceMenu()
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setTimeout(() => {
      trigger.current?.focus()
    })
  }, [trigger])

  return (
    <div ref={root} className="home-workspace-root">
      <div className="home-workspace-pill">
        <button
          ref={trigger}
          className="home-workspace-identity"
          type="button"
          aria-label={`Open ${space.displayName} menu`}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={() => {
            setIsOpen((open) => !open)
          }}
        >
          <span className="home-workspace-emoji" aria-hidden>
            {space.emoji}
          </span>
          <span className="home-workspace-name">{space.displayName}</span>
        </button>
        <button
          ref={closeButton}
          className="home-close-sidebar"
          type="button"
          aria-label="Close sidebar"
          aria-controls="space-sidebar"
          aria-expanded="true"
          onClick={() => {
            setIsOpen(false)
            closeSidebar()
          }}
        >
          <CollapseIcon />
        </button>
      </div>
      {isOpen && (
        <WorkspaceMenu
          space={space}
          close={() => {
            setIsOpen(false)
          }}
          openSettings={() => {
            setIsOpen(false)
            setSettingsOpen(true)
          }}
        />
      )}
      {settingsOpen && (
        <WorkspaceSettings
          space={space}
          close={closeSettings}
          afterLeaving={() => {
            setSettingsOpen(false)
            void navigate({ to: '/' })
          }}
        />
      )}
    </div>
  )
}

function SidebarViewButton({
  view,
  label,
  icon,
  active,
  select,
}: {
  readonly view: SidebarView
  readonly label: string
  readonly icon: ReactNode
  readonly active: boolean
  readonly select: (view: SidebarView) => void
}) {
  return (
    <button
      className="home-nav-item"
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={() => {
        select(view)
      }}
    >
      <span className="home-nav-icon">{icon}</span>
      <span className="home-nav-label">{label}</span>
    </button>
  )
}

function SidebarViews({
  slug,
  active,
  select,
}: {
  readonly slug: string
  readonly active: SidebarView
  readonly select: (view: SidebarView) => void
}) {
  return (
    <nav className="home-primary-nav" aria-label="Workspace">
      <ul>
        <li>
          <SidebarViewButton
            view="home"
            label="Home"
            icon={<HomeIcon />}
            active={active === 'home'}
            select={select}
          />
        </li>
        <li>
          <SidebarViewButton
            view="chat"
            label="Chat"
            icon={<ChatIcon />}
            active={active === 'chat'}
            select={select}
          />
        </li>
        <li>
          <Link
            className="home-nav-item"
            to="/s/$slug/inbox"
            params={{ slug }}
            aria-current={active === 'inbox' ? 'page' : undefined}
            aria-label="Inbox"
          >
            <span className="home-nav-icon">
              <InboxIcon />
            </span>
            <span className="home-nav-label">Inbox</span>
          </Link>
        </li>
      </ul>
    </nav>
  )
}

function SidebarPanel({ view, slug }: { readonly view: SidebarView; readonly slug: string }) {
  return (
    <div className="home-sidebar-panel" role="region" aria-label={`${view} sidebar`}>
      {view === 'home' && <PinnedChats slug={slug} />}
      {view === 'chat' && <ChatSidebar slug={slug} />}
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

function useSidebarVisibility() {
  const [isOpen, setIsOpen] = useState(true)
  const closeButton = useRef<HTMLButtonElement>(null)
  const openButton = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setIsOpen(false)
    requestAnimationFrame(() => {
      openButton.current?.focus()
    })
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
    requestAnimationFrame(() => {
      closeButton.current?.focus()
    })
  }, [])

  useEffect(() => {
    if (!isOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [close, isOpen])

  return { isOpen, close, open, closeButton, openButton }
}

function MainPane({
  space,
  where,
  sidebarOpen,
  openSidebar,
  openButton,
  children,
}: {
  readonly space: Space
  readonly where: string
  readonly sidebarOpen: boolean
  readonly openSidebar: () => void
  readonly openButton: RefObject<HTMLButtonElement | null>
  readonly children: ReactNode
}) {
  const canvas = where === 'Home' || where === 'Chat' || where === 'Inbox'

  return (
    <main className="home-main">
      {(!canvas || !sidebarOpen) && (
        <header className="home-topbar">
          {!sidebarOpen && (
            <button
              ref={openButton}
              className="home-open-sidebar"
              type="button"
              aria-label="Open sidebar"
              aria-controls="space-sidebar"
              aria-expanded="false"
              onClick={openSidebar}
            >
              <MenuIcon />
            </button>
          )}
          {!canvas && (
            <p className="home-breadcrumb">
              <span>{space.displayName}</span>
              <span aria-hidden>/</span>
              <strong>{where}</strong>
            </p>
          )}
        </header>
      )}

      {canvas ? (
        children
      ) : (
        <section className="home-content" aria-labelledby="home-title">
          <h1 id="home-title">{where}</h1>
          {children}
        </section>
      )}
    </main>
  )
}

function initialView(where: string): SidebarView {
  if (where === 'Inbox') return 'inbox'
  if (where === 'Chat') return 'chat'
  return 'home'
}

export function Home({ space, children }: { readonly space: Space; readonly children: ReactNode }) {
  const where = useDeepest()
  const { isOpen, close, open, closeButton, openButton } = useSidebarVisibility()
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [resizing, setResizing] = useState(false)
  const [chosenView, setChosenView] = useState<SidebarView>()
  const view = chosenView ?? initialView(where)

  return (
    <div
      className="home-shell"
      data-sidebar-open={isOpen}
      data-sidebar-resizing={resizing}
      style={{ '--home-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="home-sidebar-container">
        <aside
          id="space-sidebar"
          className="home-sidebar"
          aria-label={`${space.displayName} sidebar`}
        >
          <WorkspaceHeader space={space} closeSidebar={close} closeButton={closeButton} />
          <SidebarViews slug={space.slug} active={view} select={setChosenView} />
          <SidebarPanel view={view} slug={space.slug} />
        </aside>

        <ResizeRail width={sidebarWidth} setWidth={setSidebarWidth} setResizing={setResizing} />
      </div>

      <MainPane
        space={space}
        where={where}
        sidebarOpen={isOpen}
        openSidebar={open}
        openButton={openButton}
      >
        {children}
      </MainPane>
    </div>
  )
}
