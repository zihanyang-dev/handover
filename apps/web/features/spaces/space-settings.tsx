/**
 * Everything about a Space that is not the Space itself: who is in it, and what it can reach.
 *
 * A real `<dialog>`, opened modally. Written by hand it was a `div` claiming `aria-modal`, a Tab
 * key cycled by a query selector, and a page behind it that a screen reader could still walk
 * straight into — the promise was made in an attribute and kept for exactly one input device.
 * The element does all of it, and does it for every device: the rest of the page goes inert, the
 * backdrop is the browser's, and Escape is a `cancel` event rather than a listener racing the
 * sidebar's.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Laptop, People } from 'react-bootstrap-icons'
import { TabList, TabPanel, type Tab } from '../../components/ui/tabs.tsx'
import type { components } from '../../generated/api.ts'
import { SpaceMachines } from '../machines/space-machines.tsx'
import { SpacePeople } from './space-people.tsx'

/** The two things this dialog says about the Space it is for. Taken from the contract, not retyped. */
type Named = Pick<components['schemas']['Space'], 'slug' | 'displayName'>

const SECTIONS: readonly Tab[] = [
  { id: 'people', label: 'People', icon: <People aria-hidden /> },
  { id: 'machines', label: 'Machines', icon: <Laptop aria-hidden /> },
]

/**
 * Open for as long as it is mounted.
 *
 * `showModal` rather than an `open` attribute, which is the whole difference: only the modal form
 * puts the element in the top layer, makes everything else inert, and draws a backdrop.
 */
function useModal() {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()

    const scrolled = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = scrolled
      element?.close()
    }
  }, [])

  return dialog
}

export function SpaceSettings({
  space,
  close,
  afterLeaving,
}: {
  readonly space: Named
  readonly close: () => void
  readonly afterLeaving: () => void
}) {
  const dialog = useModal()
  const [section, setSection] = useState('people')

  /**
   * Escape, both ways it can arrive.
   *
   * A browser turns it into `cancel` on the element; that is handled below, and this is the same
   * press seen a moment earlier as a key. Both are here because they do two different jobs: this
   * one stops the press before the frame around this dialog sees it — that frame closes the whole
   * sidebar on Escape, and one press would otherwise close two things.
   */
  const closeOnEscape = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== 'Escape') return

    event.stopPropagation()
    close()
  }

  return (
    <dialog
      ref={dialog}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-0 open:flex backdrop:bg-[var(--panel-scrim)]"
      aria-label={`${space.displayName} settings`}
      onKeyDown={closeOnEscape}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      // The element itself is everything the panel does not cover, so a press here is a press
      // outside. `currentTarget` and not `target`, or every click inside the panel closes it.
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <section className="relative flex h-[calc(100%-100px)] max-h-full w-[90vw] max-w-[1512px] flex-row overflow-hidden rounded-[12px] bg-white shadow-[var(--panel-dialog-shadow)] max-sm:flex-col">
        <SettingsSections section={section} choose={setSection} />
        <TabPanel
          name="space-settings"
          active={section}
          className="relative z-[1] min-h-0 min-w-0 grow overflow-y-auto bg-white focus:outline-none"
        >
          <CloseButton close={close} />
          <div className="mx-auto w-full max-w-[880px] px-12 pt-10 pb-16 max-sm:px-5 max-sm:pt-12">
            {section === 'people' ? (
              <SpacePeople slug={space.slug} afterLeaving={afterLeaving} />
            ) : (
              <SpaceMachines slug={space.slug} />
            )}
          </div>
        </TabPanel>
      </section>
    </dialog>
  )
}

function SettingsSections({
  section,
  choose,
}: {
  readonly section: string
  readonly choose: (section: string) => void
}) {
  return (
    <aside className="h-full w-[240px] shrink-0 overflow-y-auto bg-panel-ground px-2 pt-4 max-sm:h-auto max-sm:w-full max-sm:overflow-visible max-sm:border-b max-sm:border-panel-line max-sm:px-3 max-sm:py-2">
      <p className="px-2 pb-2 text-[12px] leading-5 font-medium text-panel-ink-quiet max-sm:hidden">
        Space
      </p>
      <TabList
        name="space-settings"
        label="Settings"
        tabs={SECTIONS}
        active={section}
        choose={choose}
        orientation="vertical"
        className="flex flex-col gap-0.5 max-sm:flex-row"
        tabClassName="flex h-7 w-full cursor-pointer items-center gap-2 rounded-[5px] border-0 bg-transparent px-2 text-left text-[14px] leading-5 font-medium text-panel-ink-soft hover:bg-[var(--choice-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-selected:bg-[var(--interaction-hover-strong)] aria-selected:text-panel-ink max-sm:h-9 max-sm:w-auto max-sm:flex-1 max-sm:justify-center"
        renderTab={renderSection}
      />
    </aside>
  )
}

function renderSection(tab: Tab): ReactNode {
  return (
    <>
      <span className="flex size-4 items-center justify-center text-panel-ink-muted">
        {tab.icon}
      </span>
      {tab.label}
    </>
  )
}

function CloseButton({ close }: { readonly close: () => void }) {
  return (
    <div className="absolute top-3 right-3 z-10 size-[22px] rounded-full bg-white">
      <button
        className="flex size-full cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-panel-ink-quiet transition-colors duration-100 ease-in-out hover:bg-[var(--interaction-hover)] active:bg-[var(--interaction-pressed)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        type="button"
        aria-label="Close settings"
        onClick={close}
      >
        <CloseIcon />
      </button>
    </div>
  )
}

/** The 16px close mark measured from the same Settings dialog. */
function CloseIcon() {
  return (
    <svg className="size-[14px] shrink-0 fill-current" viewBox="0 0 16 16" aria-hidden>
      <title>Close</title>
      <path d="M12.73 4.33a.75.75 0 1 0-1.06-1.06L8 6.94 4.33 3.27a.75.75 0 0 0-1.06 1.06L6.94 8l-3.67 3.67a.75.75 0 1 0 1.06 1.06L8 9.06l3.67 3.67a.75.75 0 0 0 1.06-1.06L9.06 8z" />
    </svg>
  )
}
