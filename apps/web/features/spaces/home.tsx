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

import { useMatches, useNavigate } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { TabList, TabPanel, type Tab } from '../../components/ui/tabs.tsx'
import { ChatSidebar, PinnedChats } from '../conversations/chat-sidebar.tsx'
import { Inbox } from '../conversations/inbox.tsx'
import type { Me } from '../identity/me.ts'
import { ChatIcon, CollapseIcon, HomeIcon, InboxIcon, MenuIcon } from './sidebar-icons.tsx'
import { SpaceMenu } from './space-menu.tsx'
import { SpaceSettings, type SettingsSection } from './space-settings.tsx'

type Space = Me['spaces'][number]

/**
 * The three things the sidebar can be showing.
 *
 * Tabs and not links: all three are one view with a panel swapped underneath, and the address
 * does not change. What goes somewhere else is a link — `code-style.md` 10.1.
 */
const SIDEBAR_VIEWS: readonly Tab[] = [
  { id: 'home', label: 'Home', icon: <HomeIcon /> },
  { id: 'chat', label: 'Chat', icon: <ChatIcon /> },
  { id: 'inbox', label: 'Inbox', icon: <InboxIcon /> },
]

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

function useSpaceMenu() {
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

function SpaceHeader({
  space,
  closeSidebar,
  closeButton,
}: {
  readonly space: Space
  readonly closeSidebar: () => void
  readonly closeButton: RefObject<HTMLButtonElement | null>
}) {
  const { isOpen, setIsOpen, root, trigger } = useSpaceMenu()
  const navigate = useNavigate()
  const [settingsSection, setSettingsSection] = useState<SettingsSection>()
  const closeSettings = useCallback(() => {
    setSettingsSection(undefined)
    setTimeout(() => {
      trigger.current?.focus()
    })
  }, [trigger])

  return (
    <div ref={root} className="home-space-root">
      <div className="home-space-pill">
        <button
          ref={trigger}
          className="home-space-identity"
          type="button"
          aria-label={`Open ${space.displayName} menu`}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={() => {
            setIsOpen((open) => !open)
          }}
        >
          <span className="home-space-emoji" aria-hidden>
            {space.emoji}
          </span>
          <span className="home-space-name">{space.displayName}</span>
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
        <SpaceMenu
          space={space}
          close={() => {
            setIsOpen(false)
          }}
          openSettings={(section) => {
            setIsOpen(false)
            setSettingsSection(section)
          }}
        />
      )}
      {settingsSection !== undefined && (
        <SpaceSettings
          space={space}
          close={closeSettings}
          initialSection={settingsSection}
          afterLeaving={() => {
            setSettingsSection(undefined)
            void navigate({ to: '/' })
          }}
        />
      )}
    </div>
  )
}

function renderSidebarTab(tab: Tab) {
  return (
    <>
      <span className="home-tab-icon">{tab.icon}</span>
      <span className="home-tab-label">
        <span className="home-tab-label-clip">
          <span className="home-tab-label-text">{tab.label}</span>
        </span>
      </span>
    </>
  )
}

function SidebarPanel({ view, slug }: { readonly view: string; readonly slug: string }) {
  return (
    <TabPanel name="sidebar" active={view} className="home-sidebar-panel">
      {view === 'home' && <PinnedChats slug={slug} />}
      {view === 'chat' && <ChatSidebar slug={slug} />}
      {view === 'inbox' && <Inbox />}
    </TabPanel>
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
      <hr
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
  blocked,
  openSidebar,
  openButton,
  children,
}: {
  readonly space: Space
  readonly where: string
  readonly sidebarOpen: boolean
  readonly blocked: boolean
  readonly openSidebar: () => void
  readonly openButton: RefObject<HTMLButtonElement | null>
  readonly children: ReactNode
}) {
  const canvas = where === 'Home' || where === 'Chat'

  return (
    <main className="home-main" inert={blocked ? true : undefined}>
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

const NARROW_SIDEBAR = '(max-width: 48rem)'

function sidebarOverlays(): boolean {
  return window.matchMedia(NARROW_SIDEBAR).matches
}

function watchSidebarWidth(changed: () => void): () => void {
  const media = window.matchMedia(NARROW_SIDEBAR)
  media.addEventListener('change', changed)
  return () => {
    media.removeEventListener('change', changed)
  }
}

/** Which view the address implies. Opening a conversation is the sidebar's cue to list them. */
function viewFor(where: string): string {
  return where === 'Chat' ? 'chat' : 'home'
}

export function Home({ space, children }: { readonly space: Space; readonly children: ReactNode }) {
  const where = useDeepest()
  const { isOpen, close, open, closeButton, openButton } = useSidebarVisibility()
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [resizing, setResizing] = useState(false)
  const [chosenView, setChosenView] = useState<string>()
  const overlaysMain = useSyncExternalStore(watchSidebarWidth, sidebarOverlays, () => false)
  // Both halves answer the same question — which view is showing. Until somebody picks one the
  // address goes on deciding, so walking into a conversation brings the chat list with it; after
  // a pick it is theirs, and moving around does not take it back.
  const view = chosenView ?? viewFor(where)

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
          <SpaceHeader space={space} closeSidebar={close} closeButton={closeButton} />
          <TabList
            name="sidebar"
            label="Sidebar views"
            tabs={SIDEBAR_VIEWS}
            active={view}
            choose={setChosenView}
            className="home-tabbar"
            tabClassName="home-tab"
            renderTab={renderSidebarTab}
          />
          <SidebarPanel view={view} slug={space.slug} />
        </aside>

        <ResizeRail width={sidebarWidth} setWidth={setSidebarWidth} setResizing={setResizing} />
      </div>

      <MainPane
        space={space}
        where={where}
        sidebarOpen={isOpen}
        blocked={isOpen && overlaysMain}
        openSidebar={open}
        openButton={openButton}
      >
        {children}
      </MainPane>
    </div>
  )
}
