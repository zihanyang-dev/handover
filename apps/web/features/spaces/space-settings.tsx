/**
 * Account and Space settings in one modal, with their ownership kept visible in the navigation.
 *
 * A real `<dialog>`, opened modally. Written by hand it was a `div` claiming `aria-modal`, a Tab
 * key cycled by a query selector, and a page behind it that a screen reader could still walk
 * straight into — the promise was made in an attribute and kept for exactly one input device.
 * The element does all of it, and does it for every device: the rest of the page goes inert, the
 * backdrop is the browser's, and Escape is a `cancel` event rather than a listener racing the
 * sidebar's.
 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Laptop, People } from 'react-bootstrap-icons'
import { TabList, TabPanel, type Tab } from '../../components/ui/tabs.tsx'
import type { components } from '../../generated/api.ts'
import { AccountSettings } from '../identity/account.tsx'
import { meQuery } from '../identity/me.ts'
import { SpaceMachines } from '../machines/space-machines.tsx'
import type { RevealedInvitation } from './invitation-links.tsx'
import { SpacePeople } from './space-people.tsx'

/** The two things this dialog says about the Space it is for. Taken from the contract, not retyped. */
type Named = Pick<components['schemas']['Space'], 'slug' | 'displayName'>
type Me = components['schemas']['Me']

export type SettingsSection = 'account' | 'people' | 'machines'

function accountTabName(me: Me | undefined): string {
  if (me === undefined || me.displayName.includes('@')) return 'Account'
  return me.displayName
}

function settingsTabs(me: Me | undefined): readonly Tab[] {
  return [
    {
      id: 'account',
      label: accountTabName(me),
      group: 'Account',
      icon:
        me === undefined ? (
          <span className="size-6 rounded-full bg-fill" aria-hidden />
        ) : (
          <img className="size-6 rounded-full object-cover" src={me.avatarUrl} alt="" />
        ),
    },
    { id: 'people', label: 'People', group: 'Space', icon: <People aria-hidden /> },
    { id: 'machines', label: 'Machines', icon: <Laptop aria-hidden /> },
  ]
}

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
  initialSection = 'people',
}: {
  readonly space: Named
  readonly close: () => void
  readonly afterLeaving: () => void
  readonly initialSection?: SettingsSection
}) {
  const dialog = useModal()
  const [section, setSection] = useState(initialSection)
  // The server never stores the full secret. Keep a newly made link only while this dialog is
  // open, including while somebody checks another tab and comes back to copy it.
  const [revealedInvitation, setRevealedInvitation] = useState<RevealedInvitation>()

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
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-0 open:flex backdrop:bg-[var(--scrim)]"
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
      <section className="relative flex h-[calc(100%-100px)] max-h-full w-[90vw] max-w-[1512px] flex-row overflow-hidden rounded-[12px] bg-white shadow-[var(--dialog-shadow)] max-sm:flex-col">
        <SettingsSections section={section} choose={setSection} />
        <TabPanel
          name="space-settings"
          active={section}
          className="space-settings-panel relative z-[1] min-h-0 min-w-0 grow overflow-y-auto bg-white focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <CloseButton close={close} />
          <div className="mx-auto w-full max-w-[920px] px-[60px] pt-9 pb-16 max-sm:px-5 max-sm:pt-12">
            <SettingsContent
              section={section}
              slug={space.slug}
              spaceName={space.displayName}
              afterLeaving={afterLeaving}
              revealedInvitation={revealedInvitation}
              revealInvitation={setRevealedInvitation}
            />
          </div>
        </TabPanel>
      </section>
    </dialog>
  )
}

function SettingsContent({
  section,
  slug,
  spaceName,
  afterLeaving,
  revealedInvitation,
  revealInvitation,
}: {
  readonly section: SettingsSection
  readonly slug: string
  readonly spaceName: string
  readonly afterLeaving: () => void
  readonly revealedInvitation: RevealedInvitation | undefined
  readonly revealInvitation: (invitation: RevealedInvitation | undefined) => void
}) {
  if (section === 'account') return <AccountSettings />
  if (section === 'people')
    return (
      <SpacePeople
        slug={slug}
        afterLeaving={afterLeaving}
        revealedInvitation={revealedInvitation}
        revealInvitation={revealInvitation}
      />
    )
  return <SpaceMachines slug={slug} name={spaceName} />
}

function SettingsSections({
  section,
  choose,
}: {
  readonly section: SettingsSection
  readonly choose: (section: SettingsSection) => void
}) {
  const me = useQuery(meQuery)

  return (
    <aside className="h-full w-[240px] shrink-0 overflow-y-auto bg-surface px-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-sm:h-auto max-sm:w-full max-sm:overflow-visible max-sm:px-3 max-sm:py-2">
      <TabList
        name="space-settings"
        label="Settings"
        tabs={settingsTabs(me.data)}
        active={section}
        choose={(next) => {
          choose(next as SettingsSection)
        }}
        orientation="vertical"
        className="settings-tab-list flex flex-col gap-0.5 max-sm:flex-row"
        tabClassName="settings-tab flex h-7 w-full cursor-pointer items-center gap-2 rounded-[5px] border-0 bg-transparent px-2 text-left text-[14px] leading-5 font-medium text-ink-secondary hover:bg-[var(--interaction-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-selected:bg-[var(--interaction-hover-strong)] aria-selected:text-ink max-sm:h-9 max-sm:w-auto max-sm:flex-1 max-sm:justify-center"
        renderTab={renderSection}
        renderGroup={renderGroup}
      />
    </aside>
  )
}

function renderGroup(group: string): ReactNode {
  return (
    <p
      className={`settings-tab-group m-0 px-2 py-1.5 text-[12px] leading-4 font-medium text-ink-quiet${group === 'Space' ? ' mt-4' : ''}`}
      role="presentation"
    >
      {group}
    </p>
  )
}

function renderSection(tab: Tab): ReactNode {
  return (
    <>
      <span
        className={`flex shrink-0 items-center justify-center text-ink-muted${tab.id === 'account' ? ' size-6 -ml-1' : ' size-4'}`}
      >
        {tab.icon}
      </span>
      <span className="min-w-0 truncate">{tab.label}</span>
    </>
  )
}

function CloseButton({ close }: { readonly close: () => void }) {
  return (
    <div className="absolute top-[11px] right-[11px] z-10 size-6">
      <button
        className="group flex size-full cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-ink-quiet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        type="button"
        aria-label="Close settings"
        onClick={close}
      >
        <span className="flex size-[22px] items-center justify-center rounded-full bg-white transition-colors duration-100 ease-in-out group-hover:bg-[var(--interaction-hover)] group-active:bg-[var(--interaction-pressed)]">
          <CloseIcon />
        </span>
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
