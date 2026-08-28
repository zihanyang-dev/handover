import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { components } from '../../generated/api.ts'
import { agentName } from '../agents.ts'
import { AgentMark } from '../machines/agent-mark.tsx'

export type Model = components['schemas']['Model']
type Asked = components['schemas']['OpenConversation']['asked']
type Choice = { readonly value: string; readonly label: string; readonly about?: string }

export function askedWithChoices(text: string, model: string, effort: string): Asked {
  const asked: Asked = { text }
  if (model !== '') asked.model = model
  if (effort !== '') asked.effort = effort
  return asked
}

export function ModelChoices({
  offers,
  agentKind,
  model,
  effort,
  onModel,
  onEffort,
}: {
  readonly offers: readonly Model[]
  readonly agentKind: string
  readonly model: string
  readonly effort: string
  readonly onModel: (model: string) => void
  readonly onEffort: (effort: string) => void
}) {
  if (offers.length === 0) return null

  const modelChoices: readonly Choice[] = [
    { value: '', label: 'Auto', about: 'Balances speed, effort, and cost.' },
    ...offers.map(asModelChoice),
  ]
  const activeModel =
    offers.find((offer) => offer.id === model) ??
    offers.find((offer) => offer.isDefault) ??
    offers[0]
  const effortChoices = choicesForEffort(activeModel)

  return (
    <div className="chat-model-choices">
      <ChoiceMenu
        kind="model"
        agentKind={agentKind}
        label="Model"
        section={agentName(agentKind)}
        value={model}
        choices={modelChoices}
        onChange={onModel}
      />
      {effortChoices.length > 1 && (
        <ChoiceMenu
          kind="effort"
          agentKind={agentKind}
          label="Thinking"
          section="Thinking"
          value={effort}
          choices={effortChoices}
          onChange={onEffort}
        />
      )}
    </div>
  )
}

function choicesForEffort(model: Model | undefined): readonly Choice[] {
  if (model === undefined || model.efforts.length === 0) return []
  return [
    { value: '', label: 'Default', about: defaultEffort(model) },
    ...model.efforts.map((effort) => ({ value: effort, label: titled(effort) })),
  ]
}

function defaultEffort(model: Model): string {
  return model.defaultEffort === undefined
    ? 'Use the agent default.'
    : `Uses ${titled(model.defaultEffort)}.`
}

function titled(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function choiceLabel(choices: readonly Choice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? choices[0]?.label ?? ''
}

function compactLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)$/u, '')
}

function asModelChoice(offer: Model): Choice {
  const choice = { value: offer.id, label: offer.name }
  const about = modelDetail(offer.about)
  if (about === undefined) return choice
  return { ...choice, about }
}

function compactAbout(about: string): string {
  return about.split(' · ', 1)[0] ?? about
}

function modelDetail(about: string | undefined): string | undefined {
  if (about === undefined) return undefined
  const detail = compactAbout(about)
  return /\d/u.test(detail) ? detail : undefined
}

function ChoiceMenu({
  kind,
  agentKind,
  label,
  section,
  value,
  choices,
  onChange,
}: {
  readonly kind: 'model' | 'effort'
  readonly agentKind: string
  readonly label: string
  readonly section: string
  readonly value: string
  readonly choices: readonly Choice[]
  readonly onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  useDismissed(open, root, menu, setOpen)
  usePlaced(open, root, trigger, menu)
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
    <div ref={root} className="chat-choice" data-kind={kind}>
      <button
        ref={trigger}
        className="chat-choice-trigger"
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
          <div
            ref={menu}
            id={menuId}
            className="chat-choice-menu"
            role="menu"
            tabIndex={-1}
            aria-label={label}
            onKeyDown={(event) => {
              moveThroughChoices(event, open, options)
            }}
          >
            <ChoiceOption
              choice={choices[0]}
              index={0}
              selected={choices[0]?.value === value}
              showMark={false}
              agentKind={agentKind}
              remember={(index, element) => {
                options.current[index] = element
              }}
              choose={(next) => {
                onChange(next)
                setOpen(false)
                trigger.current?.focus()
              }}
            />
            <div className="chat-choice-divider" />
            <p className="chat-choice-section">{section}</p>
            {choices.slice(1).map((choice, index) => (
              <ChoiceOption
                key={choice.value}
                choice={choice}
                index={index + 1}
                selected={choice.value === value}
                showMark={kind === 'model'}
                agentKind={agentKind}
                remember={(optionIndex, element) => {
                  options.current[optionIndex] = element
                }}
                choose={(next) => {
                  onChange(next)
                  setOpen(false)
                  trigger.current?.focus()
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

function ChoiceOption({
  choice,
  index,
  selected,
  showMark,
  agentKind,
  remember,
  choose,
}: {
  readonly choice: Choice | undefined
  readonly index: number
  readonly selected: boolean
  readonly showMark: boolean
  readonly agentKind: string
  readonly remember: (index: number, element: HTMLButtonElement | null) => void
  readonly choose: (value: string) => void
}) {
  if (choice === undefined) return null
  return (
    <button
      ref={(element) => {
        remember(index, element)
      }}
      className="chat-choice-option"
      data-featured={index === 0}
      type="button"
      role="menuitemradio"
      aria-label={choice.label}
      aria-checked={selected}
      onClick={() => {
        choose(choice.value)
      }}
    >
      {showMark && (
        <span className="chat-choice-mark" data-kind={agentKind} aria-hidden="true">
          <AgentMark kind={agentKind} />
        </span>
      )}
      <span className="chat-choice-copy">
        <strong>{compactLabel(choice.label)}</strong>
        {choice.about !== undefined && (
          <small title={choice.about}>{compactAbout(choice.about)}</small>
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
  root: RefObject<HTMLDivElement | null>,
  menu: RefObject<HTMLDivElement | null>,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return undefined
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>('.chat-choice-trigger')?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [menu, open, root, setOpen])
}

function moveThroughChoices(
  event: ReactKeyboardEvent<HTMLDivElement>,
  open: boolean,
  options: RefObject<(HTMLButtonElement | null)[]>,
): void {
  if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
  event.preventDefault()
  const available = options.current.filter((option) => option !== null)
  const current = available.indexOf(document.activeElement as HTMLButtonElement)
  const direction = event.key === 'ArrowDown' ? 1 : -1
  const next = (current + direction + available.length) % available.length
  available[next]?.focus()
}

function CheckIcon() {
  return (
    <svg className="chat-choice-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8 2.75 2.75 6.25-6.25" />
    </svg>
  )
}
