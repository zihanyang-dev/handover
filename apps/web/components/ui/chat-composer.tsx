// The composer structure is adapted from Kanna's ChatInput.
// Its copyright and source terms are retained in THIRD_PARTY_NOTICES.md.

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

const MAX_TEXTAREA_HEIGHT = 320

export function Composer({
  label,
  placeholder,
  text,
  onText,
  onSend,
  action,
  leading,
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
  readonly action: ReactNode
  /** What sits at the bottom-left of the box, before the choices. */
  readonly leading?: ReactNode
  readonly disabled?: boolean
  readonly takesFocus?: boolean
  readonly className?: string
  readonly children: ReactNode
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const element = textarea.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${String(Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT))}px`
  }, [text])

  const submitFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  return (
    <div className={`chat-composer ${className}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim() === '' || disabled) return
          onSend()
        }}
      >
        <div className="chat-composer-stack">
          <div className="chat-composer-box">
            <textarea
              ref={textarea}
              aria-label={label}
              placeholder={placeholder}
              rows={1}
              autoFocus={takesFocus}
              disabled={disabled}
              value={text}
              onChange={(event) => {
                onText(event.target.value)
              }}
              onKeyDown={submitFromKeyboard}
            />
            <div className="chat-composer-bar">
              <div className="chat-composer-left">
                {leading}
                {children}
              </div>
              <div className="chat-composer-right">{action}</div>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}

export function ComposerError({ children }: { readonly children: ReactNode }) {
  return (
    <span className="chat-composer-error" role="alert">
      {children}
    </span>
  )
}

const CONTROL = 'chat-composer-control'

export function SendButton({ disabled }: { readonly disabled: boolean }) {
  return (
    <button className={CONTROL} type="submit" aria-label="Send" disabled={disabled}>
      <svg className="size-3.5 fill-current" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M.743 3.773c-.818-.555-.422-1.834.567-1.828l11.496.074a1 1 0 0 1 .837 1.538l-6.189 9.689c-.532.833-1.822.47-1.842-.518L5.525 8.51a1 1 0 0 1 .522-.9l1.263-.686a.808.808 0 0 0-.772-1.42l-1.263.686a1 1 0 0 1-1.039-.051L.743 3.773Z" />
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
      className={CONTROL}
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
