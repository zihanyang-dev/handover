import { useEffect, useRef, useState } from 'react'
import { Laptop, People } from 'react-bootstrap-icons'
import { createPortal } from 'react-dom'
import { WorkspaceMachines } from '../machines/workspace-machines.tsx'
import { WorkspacePeople } from './workspace-people.tsx'

type SettingsSection = 'people' | 'machines'

type Workspace = {
  readonly slug: string
  readonly displayName: string
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function WorkspaceSettings({
  space,
  close,
  afterLeaving,
}: {
  readonly space: Workspace
  readonly close: () => void
  readonly afterLeaving: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  const [section, setSection] = useState<SettingsSection>('people')

  useDialog(dialog, close)

  return createPortal(
    <div className="fixed inset-0 z-[100] flex h-dvh w-screen transform-gpu items-center justify-center opacity-100 transition-[opacity,transform] duration-200 [transition-timing-function:ease] starting:opacity-0 motion-reduce:transition-none">
      <div className="absolute inset-0 bg-[rgba(15,15,15,0.6)]" aria-hidden onClick={close} />
      <section
        ref={dialog}
        className="relative z-[1] h-[calc(100%-100px)] max-h-full w-[90vw] max-w-[1512px] overflow-hidden rounded-[12px] bg-white [box-shadow:0_24px_48px_rgba(25,25,25,0.24),0_4px_12px_rgba(25,25,25,0.14),0_0_0_1px_rgba(42,28,0,0.07)] [transform:translateZ(0)_scale(1)] [transition-property:transform] duration-200 [transition-timing-function:ease] starting:[transform:translateZ(0)_scale(0.96)] focus:outline-none motion-reduce:transition-none"
        role="dialog"
        aria-modal="true"
        aria-label={`${space.displayName} settings`}
        tabIndex={-1}
      >
        <div className="flex h-full flex-row max-sm:flex-col" role="presentation">
          <SettingsNavigation section={section} select={setSection} />
          <main className="relative z-[1] min-h-0 min-w-0 grow overflow-y-auto bg-white">
            <CloseButton close={close} />
            <div className="mx-auto w-full max-w-[880px] px-12 pt-10 pb-16 max-sm:px-5 max-sm:pt-12">
              {section === 'people' && (
                <WorkspacePeople slug={space.slug} afterLeaving={afterLeaving} />
              )}
              {section === 'machines' && <WorkspaceMachines slug={space.slug} />}
            </div>
          </main>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function useDialog(dialog: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    ;(first ?? dialog.current)?.focus()

    const keydown = (event: KeyboardEvent) => {
      handleDialogKey(event, dialog.current, close)
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.body.style.overflow = bodyOverflow
    }
  }, [close, dialog])
}

function handleDialogKey(event: KeyboardEvent, dialog: HTMLElement | null, close: () => void) {
  if (event.key === 'Escape') {
    event.stopImmediatePropagation()
    close()
    return
  }
  if (event.key !== 'Tab' || dialog === null) return

  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (control) => control.getClientRects().length > 0 || control === document.activeElement,
  )
  const first = controls.at(0)
  const last = controls.at(-1)
  if (first === undefined || last === undefined) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function SettingsNavigation({
  section,
  select,
}: {
  readonly section: SettingsSection
  readonly select: (section: SettingsSection) => void
}) {
  return (
    <aside className="h-full w-[240px] shrink-0 overflow-y-auto bg-[#f9f8f7] px-2 pt-4 max-sm:h-auto max-sm:w-full max-sm:overflow-visible max-sm:border-b max-sm:border-[#e9e8e6] max-sm:px-3 max-sm:py-2">
      <p className="px-2 pb-2 text-[12px] leading-5 font-medium text-[#92908c] max-sm:hidden">
        Workspace
      </p>
      <div className="flex flex-col gap-0.5 max-sm:flex-row" role="tablist" aria-label="Settings">
        <SettingsTab
          active={section === 'people'}
          label="People"
          icon={<People aria-hidden />}
          select={() => {
            select('people')
          }}
        />
        <SettingsTab
          active={section === 'machines'}
          label="Machines"
          icon={<Laptop aria-hidden />}
          select={() => {
            select('machines')
          }}
        />
      </div>
    </aside>
  )
}

function SettingsTab({
  active,
  label,
  icon,
  select,
}: {
  readonly active: boolean
  readonly label: string
  readonly icon: React.ReactNode
  readonly select: () => void
}) {
  return (
    <button
      className="flex h-7 w-full items-center gap-2 rounded-[5px] border-0 bg-transparent px-2 text-left text-[14px] leading-5 font-medium text-[#5f5e5b] hover:bg-[rgba(55,53,47,0.06)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de] aria-selected:bg-[rgba(55,53,47,0.08)] aria-selected:text-[#2f2e2b] max-sm:h-9 max-sm:w-auto max-sm:flex-1 max-sm:justify-center"
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={select}
    >
      <span className="flex size-4 items-center justify-center text-[#7b7975]">{icon}</span>
      {label}
    </button>
  )
}

function CloseButton({ close }: { readonly close: () => void }) {
  return (
    <div className="absolute top-3 right-3 z-10 size-[22px] rounded-full bg-white">
      <button
        className="flex size-full cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[#8e8b86] transition-colors duration-100 ease-in-out hover:bg-[rgba(33,27,23,0.05)] active:bg-[rgba(33,27,23,0.1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
        type="button"
        aria-label="Close settings"
        onClick={close}
      >
        <CloseIcon />
      </button>
    </div>
  )
}

/** The 16px close mark measured from Notion's live Settings dialog. */
function CloseIcon() {
  return (
    <svg className="size-[14px] shrink-0 fill-current" viewBox="0 0 16 16" aria-hidden>
      <title>Close</title>
      <path d="M12.73 4.33a.75.75 0 1 0-1.06-1.06L8 6.94 4.33 3.27a.75.75 0 0 0-1.06 1.06L6.94 8l-3.67 3.67a.75.75 0 1 0 1.06 1.06L8 9.06l3.67 3.67a.75.75 0 0 0 1.06-1.06L9.06 8z" />
    </svg>
  )
}
