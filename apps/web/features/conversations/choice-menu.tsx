/**
 * The small menu beside the send button, and everything that places and dismisses it.
 *
 * One component rather than one per thing there is to choose. Which model, how hard to think and
 * where the work happens are three different questions with the same answer shape — a short list,
 * one of them current — and they have to look like one control repeated, not three that drifted.
 *
 * Kept apart from what any of them mean: this file knows about a list and a current value, and
 * nothing about models or directories.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

export type Choice = { readonly value: string; readonly label: string; readonly about?: string }

/** The label without whatever it says in brackets, which is detail the trigger has no room for. */
function compactLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)$/u, '')
}

/** The first part of a description, which is the part that is about the thing rather than about it. */
export function compactAbout(about: string): string {
  return about.split(' · ', 1)[0] ?? about
}

function choiceLabel(choices: readonly Choice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? choices[0]?.label ?? ''
}

export function ChoiceMenu({
  label,
  saysNothing,
  section,
  alternatives,
  value,
  onChange,
  mark,
}: {
  readonly label: string
  /**
   * The first row: what happens when a person chooses nothing.
   *
   * Its own field rather than the head of the list, because it is drawn differently — larger,
   * with its description on a second line, above a divider and outside the section below. Left
   * as `choices[0]`, that was a rule about an index, which the next list to be passed in has no
   * way of knowing about.
   */
  readonly saysNothing: Choice
  /** What the section under the divider is called. */
  readonly section: string
  readonly alternatives: readonly Choice[]
  readonly value: string
  readonly onChange: (value: string) => void
  /**
   * Drawn at the start of every alternative, when the alternatives are somebody's own things.
   *
   * Passed in rather than named, so this file knows nothing about agents. Never on the first
   * row: what happens when you choose nothing belongs to nobody.
   */
  readonly mark?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  useDismissed(open, { root, menu, trigger }, setOpen)
  usePlaced(open, root, trigger, menu)
  const choices = [saysNothing, ...alternatives]
  const current = choiceLabel(choices, value)

  const show = (): void => {
    setOpen(true)
    requestAnimationFrame(() => {
      const selected = Math.max(
        0,
        choices.findIndex((choice) => choice.value === value),
      )
      options.current[selected]?.focus()
    })
  }

  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={trigger}
        // The name is load-bearing, not decoration: the composer keeps its own ring while one of
        // these is open, and it finds out by looking for this — see `chat.css`.
        className="chat-choice-trigger flex h-7 w-full max-w-36 min-w-0 cursor-pointer items-center overflow-hidden rounded-[3.125rem] border-0 bg-transparent px-3 font-[inherit] text-copy-xs/5 font-medium text-ellipsis whitespace-nowrap text-ink-muted hover:bg-[var(--choice-hover)] aria-expanded:bg-[var(--choice-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        type="button"
        aria-label={`${label}: ${current}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) setOpen(false)
          else show()
        }}
      >
        {compactLabel(current)}
      </button>

      {open &&
        createPortal(
          <OpenChoices
            id={menuId}
            menu={menu}
            label={label}
            section={section}
            saysNothing={saysNothing}
            alternatives={alternatives}
            value={value}
            mark={mark}
            remember={(index, element) => {
              options.current[index] = element
            }}
            moveFocus={(event) => {
              moveThroughChoices(event, options)
            }}
            choose={(next) => {
              onChange(next)
              setOpen(false)
              trigger.current?.focus()
            }}
          />,
          document.body,
        )}
    </div>
  )
}

/**
 * The list itself, which lives at the end of the document rather than beside its trigger.
 *
 * Portalled because a composer clips: the box the menu opens out of has `overflow` on it and a
 * stacking context of its own, so a list rendered inside it is cut off at the edge of the
 * textarea. Its position is put on it by `usePlaced` for the same reason — there is no longer
 * anything above it in the tree to lay it out.
 */
function OpenChoices({
  id,
  menu,
  label,
  section,
  saysNothing,
  alternatives,
  value,
  mark,
  remember,
  moveFocus,
  choose,
}: {
  readonly id: string
  readonly menu: RefObject<HTMLDivElement | null>
  readonly label: string
  readonly section: string
  readonly saysNothing: Choice
  readonly alternatives: readonly Choice[]
  readonly value: string
  readonly mark?: ReactNode
  /** Told where each row ended up, so the arrow keys have something to move between. */
  readonly remember: (index: number, element: HTMLButtonElement | null) => void
  readonly moveFocus: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  readonly choose: (value: string) => void
}) {
  return (
    <div
      ref={menu}
      id={id}
      className="fixed z-100 max-h-[17.375rem] w-75 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-[0.625rem] bg-base p-1 shadow-[var(--surface-raised-shadow)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="menu"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={moveFocus}
    >
      <ChoiceOption
        choice={saysNothing}
        index={0}
        selected={saysNothing.value === value}
        remember={remember}
        choose={choose}
      />
      <div className="mx-2 mt-2 mb-1.5 h-px bg-[var(--choice-divider)]" />
      <p className="m-0 px-2 py-1 text-copy-xxs/5 font-semibold text-ink-muted">{section}</p>
      {alternatives.map((choice, index) => (
        <ChoiceOption
          key={choice.value}
          choice={choice}
          index={index + 1}
          selected={choice.value === value}
          mark={mark}
          remember={remember}
          choose={choose}
        />
      ))}
    </div>
  )
}

function ChoiceOption({
  choice,
  index,
  selected,
  mark,
  remember,
  choose,
}: {
  readonly choice: Choice
  readonly index: number
  readonly selected: boolean
  readonly mark?: ReactNode
  readonly remember: (index: number, element: HTMLButtonElement | null) => void
  readonly choose: (value: string) => void
}) {
  return (
    <button
      ref={(element) => {
        remember(index, element)
      }}
      className="group flex w-full min-h-7 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left font-[inherit] text-copy-xs/5 text-ink hover:bg-[var(--choice-hover)] focus-visible:bg-[var(--choice-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus data-[featured=true]:min-h-[2.9375rem] data-[featured=true]:py-1"
      data-featured={index === 0}
      type="button"
      role="menuitemradio"
      aria-label={choice.label}
      aria-checked={selected}
      onClick={() => {
        choose(choice.value)
      }}
    >
      {mark}
      <span className="flex min-w-0 flex-1 gap-2 group-data-[featured=true]:flex-col group-data-[featured=true]:gap-0">
        <strong className="max-w-[62%] flex-none overflow-hidden text-copy-xs/5 font-normal text-ellipsis whitespace-nowrap only:max-w-full group-aria-checked:font-medium group-data-[featured=true]:max-w-full">
          {compactLabel(choice.label)}
        </strong>
        {choice.about !== undefined && (
          <small className="min-w-0 overflow-hidden text-copy-xxs/[1.125rem] text-ellipsis whitespace-nowrap text-ink-muted">
            {compactAbout(choice.about)}
          </small>
        )}
      </span>
      {selected && <CheckIcon />}
    </button>
  )
}

function usePlaced(
  open: boolean,
  root: RefObject<HTMLDivElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
  menu: RefObject<HTMLDivElement | null>,
): void {
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = (): void => {
      if (root.current === null || trigger.current === null || menu.current === null) return
      placeMenu(root.current, trigger.current, menu.current)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [menu, open, root, trigger])
}

function menuAnchor(root: HTMLDivElement, trigger: HTMLButtonElement): DOMRect {
  if (window.innerWidth > 768) return trigger.getBoundingClientRect()
  return root.closest('form')?.getBoundingClientRect() ?? trigger.getBoundingClientRect()
}

function horizontalPlacement(anchor: DOMRect, trigger: DOMRect): { width: number; left: number } {
  const edge = 12
  if (window.innerWidth <= 768) {
    const width = Math.min(300, anchor.width, window.innerWidth - edge * 2)
    const left = Math.min(Math.max(edge, anchor.left), window.innerWidth - edge - width)
    return { width, left }
  }
  const width = Math.min(300, window.innerWidth - edge * 2)
  const left = Math.min(Math.max(edge, trigger.right - width), window.innerWidth - edge - width)
  return { width, left }
}

function placeMenu(root: HTMLDivElement, trigger: HTMLButtonElement, menu: HTMLDivElement): void {
  const triggerBox = trigger.getBoundingClientRect()
  const anchor = menuAnchor(root, trigger)
  const { width, left } = horizontalPlacement(anchor, triggerBox)
  const edge = 12
  const gap = window.innerWidth <= 768 ? 8 : 2
  const below = window.innerHeight - anchor.bottom - gap - edge
  const above = anchor.top - gap - edge
  const desired = Math.min(278, menu.scrollHeight)
  const opensBelow = below >= Math.min(desired, 160) || below >= above
  const available = Math.max(0, opensBelow ? below : above)

  Object.assign(menu.style, {
    right: 'auto',
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(desired, available)}px`,
    top: opensBelow ? `${anchor.bottom + gap}px` : 'auto',
    bottom: opensBelow ? 'auto' : `${window.innerHeight - anchor.top + gap}px`,
  })
}

function useDismissed(
  open: boolean,
  parts: {
    readonly root: RefObject<HTMLDivElement | null>
    readonly menu: RefObject<HTMLDivElement | null>
    readonly trigger: RefObject<HTMLButtonElement | null>
  },
  setOpen: (open: boolean) => void,
): void {
  const { root, menu, trigger } = parts

  useEffect(() => {
    if (!open) return undefined
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // The trigger itself, by the ref that renders it. It used to be looked up by a class name
      // that nothing puts on it, so Escape left the focus wherever the menu had it.
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [menu, open, root, setOpen, trigger])
}

function moveThroughChoices(
  event: ReactKeyboardEvent<HTMLDivElement>,
  options: RefObject<(HTMLButtonElement | null)[]>,
): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const available = options.current.filter((option) => option !== null)
  const current = available.indexOf(document.activeElement as HTMLButtonElement)
  const direction = event.key === 'ArrowDown' ? 1 : -1
  const next = (current + direction + available.length) % available.length
  available[next]?.focus()
}

function CheckIcon() {
  return (
    <svg
      className="size-4 flex-none fill-none stroke-current stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round]"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="m3.5 8 2.75 2.75 6.25-6.25" />
    </svg>
  )
}
