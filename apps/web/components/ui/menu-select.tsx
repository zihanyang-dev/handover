import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Check2, ChevronDown } from 'react-bootstrap-icons'

type Choice<Value extends string> = {
  readonly value: Value
  readonly label: string
}

type DangerAction = {
  readonly label: string
  readonly choose: () => void
}

function useOutsideDismiss(
  open: boolean,
  root: RefObject<HTMLDivElement | null>,
  dismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss()
    }
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
    }
  }, [dismiss, open, root])
}

function nextOption(key: string, at: number, length: number): number | undefined {
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (key === 'ArrowDown') return (Math.max(0, at) + 1) % length
  if (key === 'ArrowUp') return at <= 0 ? length - 1 : at - 1
  return undefined
}

function ChoicesMenu<Value extends string>({
  label,
  value,
  choices,
  options,
  dangerAction,
  stretch,
  choose,
  close,
}: {
  readonly label: string
  readonly value: Value
  readonly choices: readonly Choice<Value>[]
  readonly options: RefObject<(HTMLButtonElement | null)[]>
  readonly dangerAction: DangerAction | undefined
  readonly stretch: boolean
  readonly choose: (value: Value) => void
  readonly close: () => void
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const at = options.current.findIndex((option) => option === document.activeElement)
    const next = nextOption(event.key, at, choices.length)
    if (next === undefined) return
    event.preventDefault()
    options.current[next]?.focus()
  }

  return (
    <div
      className={
        stretch
          ? 'absolute top-full left-0 z-20 mt-1 w-full min-w-44 rounded-[7px] bg-white p-1 shadow-[var(--surface-raised-shadow)]'
          : 'absolute top-full right-0 z-20 mt-1 w-44 rounded-[7px] bg-white p-1 shadow-[var(--surface-raised-shadow)]'
      }
      role="menu"
      aria-label={label}
      onKeyDown={move}
    >
      <div className="flex flex-col gap-1" role="none">
        {choices.map((choice, index) => (
          <button
            key={choice.value}
            ref={(element) => {
              options.current[index] = element
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[5px] border-0 bg-transparent px-2 text-left text-[13px] text-ink hover:bg-[var(--interaction-hover)] focus:bg-[var(--interaction-hover)] focus:outline-none"
            type="button"
            role="menuitemradio"
            aria-checked={choice.value === value}
            onClick={() => {
              choose(choice.value)
            }}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {choice.value === value && <Check2 className="size-3.5" aria-hidden />}
            </span>
            {choice.label}
          </button>
        ))}
      </div>
      {dangerAction !== undefined && (
        <>
          <hr className="my-1 h-px border-0 bg-line" />
          <button
            className="flex h-8 w-full items-center rounded-[5px] border-0 bg-transparent px-2 text-left text-[13px] text-danger-quiet hover:bg-danger-wash focus:bg-danger-wash focus:outline-none"
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              dangerAction.choose()
            }}
          >
            {dangerAction.label}
          </button>
        </>
      )}
    </div>
  )
}

/** A compact menu select for settings rows; the browser's native popup cannot match the dialog. */
export function MenuSelect<Value extends string>({
  label,
  value,
  choices,
  onChange,
  disabled = false,
  dangerAction,
  stretch = false,
}: {
  readonly label: string
  readonly value: Value
  readonly choices: readonly Choice<Value>[]
  readonly onChange: (value: Value) => void
  readonly disabled?: boolean
  readonly dangerAction?: DangerAction | undefined
  readonly stretch?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value),
  )
  const current = choices[selected]?.label ?? value
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  useOutsideDismiss(open, root, () => {
    setOpen(false)
  })

  const show = (): void => {
    setOpen(true)
    requestAnimationFrame(() => {
      options.current[selected]?.focus()
    })
  }

  return (
    <div ref={root} className={stretch ? 'relative w-full' : 'relative shrink-0'}>
      <button
        ref={trigger}
        className={
          stretch
            ? 'flex h-8 w-full min-w-[96px] items-center justify-between gap-2 rounded-[5px] border border-line-firm bg-white px-2 text-[13px] font-normal text-ink-secondary hover:bg-fill aria-expanded:bg-fill focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-ink-faint'
            : 'flex h-7 min-w-[96px] items-center justify-between gap-2 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-normal text-ink-secondary hover:bg-[var(--interaction-hover)] aria-expanded:bg-[var(--interaction-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-ink-faint'
        }
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show()
          }
        }}
        onClick={() => {
          if (open) setOpen(false)
          else show()
        }}
      >
        <span>{current}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-quiet" aria-hidden />
      </button>

      {open && (
        <ChoicesMenu
          label={label}
          value={value}
          choices={choices}
          options={options}
          dangerAction={dangerAction}
          stretch={stretch}
          close={close}
          choose={(next) => {
            onChange(next)
            close()
          }}
        />
      )}
    </div>
  )
}
