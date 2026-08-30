/**
 * A set of tabs and the panel they control.
 *
 * Only for a panel that is swapped **in this view**. Something that goes to another address is a
 * link, and dressing one up as a tab takes its keyboard behaviour away — see `code-style.md` 10.1.
 *
 * Here rather than written out twice because what is easy to get wrong is not the markup, it is
 * the keyboard: a tab strip is one stop, and the arrows move within it. Written out per screen,
 * one of them had `aria-pressed` on three buttons — which says three independent switches, and
 * makes a reader work out for themselves that exactly one is ever on — and the other had the
 * right roles and no arrow keys at all.
 *
 * Ids are built from a `name` the caller gives, so the strip and its panel agree without a
 * context and without either of them holding a ref to the other. Two strips on one page need two
 * names, which is the same thing a `useId` would have done and says so out loud.
 */

import type { KeyboardEvent, ReactNode } from 'react'

export type Tab = {
  readonly id: string
  readonly label: string
  readonly icon?: ReactNode
}

function tabId(name: string, tab: string): string {
  return `${name}-tab-${tab}`
}

function panelId(name: string, tab: string): string {
  return `${name}-panel-${tab}`
}

/**
 * Which way each arrow goes.
 *
 * Both pairs in both orientations, which is more than the pattern asks for: a strip says which it
 * is with `aria-orientation`, and a reader who presses the other pair gets what they meant rather
 * than nothing.
 */
const STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/** Where the arrows land, wrapping at both ends so a strip has no dead press. */
function nextTab(tabs: readonly Tab[], from: string, key: string): string | undefined {
  const at = tabs.findIndex((tab) => tab.id === from)
  if (at < 0) return undefined
  if (key === 'Home') return tabs[0]?.id
  if (key === 'End') return tabs.at(-1)?.id

  const step = STEP[key]
  if (step === undefined) return undefined

  return tabs[(at + step + tabs.length) % tabs.length]?.id
}

export function TabList({
  name,
  label,
  tabs,
  active,
  choose,
  orientation = 'horizontal',
  className,
  tabClassName,
  renderTab,
}: {
  readonly name: string
  readonly label: string
  readonly tabs: readonly Tab[]
  readonly active: string
  readonly choose: (id: string) => void
  readonly orientation?: 'horizontal' | 'vertical'
  readonly className?: string
  /** On every tab, so a screen can style the selected one through `aria-selected`. */
  readonly tabClassName?: string
  /** What is inside one tab. Its attributes are this file's; what it looks like is the screen's. */
  readonly renderTab: (tab: Tab) => ReactNode
}) {
  // Selection follows focus, which is right exactly while a panel costs nothing to show: every
  // one of these is already loaded, so arrowing through them shows them rather than making
  // somebody press twice.
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const going = nextTab(tabs, active, event.key)
    if (going === undefined) return

    event.preventDefault()
    choose(going)
    document.getElementById(tabId(name, going))?.focus()
  }

  return (
    <div
      className={className}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      onKeyDown={move}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={tabId(name, tab.id)}
          className={tabClassName}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          aria-controls={panelId(name, tab.id)}
          // One stop for the whole strip: inside it the arrows move, and Tab leaves it.
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => {
            choose(tab.id)
          }}
        >
          {renderTab(tab)}
        </button>
      ))}
    </div>
  )
}

/**
 * What the chosen tab shows.
 *
 * Focusable, because the panel may hold nothing focusable of its own — and then somebody who
 * tabbed off the strip would land past everything the strip is for.
 */
export function TabPanel({
  name,
  active,
  className,
  children,
}: {
  readonly name: string
  readonly active: string
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <div
      id={panelId(name, active)}
      className={className}
      // Which tab it is showing, for the screen's own styling: a panel that looks different
      // depending on what is in it has to be able to say which that is without the stylesheet
      // reaching inside it.
      data-tab={active}
      role="tabpanel"
      aria-labelledby={tabId(name, active)}
      tabIndex={0}
    >
      {children}
    </div>
  )
}
