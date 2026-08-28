/**
 * The box somebody types into, and the one control at the end of it.
 *
 * Sizes come from this product's own scale — `text-copy-s`, not `text-base`. The token
 * `--color-base` is this product's white, so `text-base` is read as *that colour*, and asking for
 * a font size with it silently paints the words in six percent of white instead.
 *
 * One component rather than one stylesheet rule with two class names on it: the box on an agent's
 * own page and the box under a transcript are the same box, and they were the same box only
 * because two selectors were kept in a list together. What each screen passes in is what differs
 * — what it is called, what it says when empty, and what sits beside the button.
 */

import type { ReactNode } from 'react'

export function Composer({
  label,
  placeholder,
  text,
  onText,
  onSend,
  disabled = false,
  takesFocus = false,
  className = '',
  children,
}: {
  readonly label: string
  readonly placeholder: string
  readonly text: string
  readonly onText: (text: string) => void
  readonly onSend: () => void
  readonly disabled?: boolean
  /** Whether the cursor starts here. True on a screen whose whole purpose is this box. */
  readonly takesFocus?: boolean
  /** Where it sits on the screen holding it, which is that screen's to say and not this one's. */
  readonly className?: string
  /** What sits to the left of the button: anything refused, and what may be chosen. */
  readonly children: ReactNode
}) {
  return (
    <form
      // Outlined rather than ringed, and always two pixels of it: transparent until something is
      // being typed into it, so the box never changes size when it takes focus.
      className={`w-full rounded-[1.375rem] bg-base p-1 shadow-[var(--surface-raised-shadow)] outline-2 outline-transparent transition-[outline-color] duration-100 ease-in-out focus-within:outline-focus ${className}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (text.trim() === '' || disabled) return
        onSend()
      }}
    >
      <textarea
        className="block h-15 min-h-15 w-full resize-none border-0 bg-transparent pt-3 pr-3 pb-0 pl-3.5 font-[inherit] text-copy-s/6 text-ink outline-none placeholder:text-ink-placeholder"
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        autoFocus={takesFocus}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          onText(event.target.value)
        }}
      />
      <div className="relative flex min-h-10 items-center justify-end gap-1 pt-1 pr-2 pb-2 pl-2.5">
        {children}
      </div>
    </form>
  )
}

/** Why what was typed did not go. Pushed left so the controls stay where the eye expects them. */
export function ComposerError({ children }: { readonly children: ReactNode }) {
  return (
    <span className="mr-auto text-copy-xxs text-danger" role="alert">
      {children}
    </span>
  )
}

const CONTROL =
  'grid size-7 flex-none cursor-pointer place-items-center rounded-[1.875rem] border-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:bg-[#2a1c0012] disabled:text-[#37352f52]'

export function SendButton({ disabled }: { readonly disabled: boolean }) {
  return (
    <button
      className={`${CONTROL} bg-[#2783de] text-[#f3f9fd] not-disabled:hover:bg-[#1877d2]`}
      type="submit"
      aria-label="Send"
      disabled={disabled}
    >
      <svg className="size-4 fill-current" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M12.33 7.33a.75.75 0 0 0 0-1.06l-3.8-3.8a.75.75 0 0 0-1.06 0l-3.8 3.8a.75.75 0 0 0 1.06 1.06l2.52-2.52V13a.75.75 0 0 0 1.5 0V4.81l2.52 2.52a.75.75 0 0 0 1.06 0Z" />
      </svg>
    </button>
  )
}

export function StopButton({
  disabled,
  onStop,
}: {
  readonly disabled: boolean
  readonly onStop: () => void
}) {
  return (
    <button
      className={`${CONTROL} bg-[#37352f14] text-ink-secondary`}
      type="button"
      aria-label="Stop"
      disabled={disabled}
      onClick={onStop}
    >
      <svg className="size-4 fill-current" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.5" y="4.5" width="7" height="7" rx="1.25" />
      </svg>
    </button>
  )
}
