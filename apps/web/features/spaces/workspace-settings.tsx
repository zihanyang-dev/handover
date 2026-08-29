import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export function WorkspaceSettings({
  label,
  close,
}: {
  readonly label: string
  readonly close: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()

    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        closeButton.current?.focus()
        return
      }
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      close()
    }

    document.addEventListener('keydown', handleKeyboard, true)
    return () => {
      document.removeEventListener('keydown', handleKeyboard, true)
      document.body.style.overflow = bodyOverflow
    }
  }, [close])

  return createPortal(
    <div className="fixed inset-0 z-[100] flex h-dvh w-screen transform-gpu items-center justify-center opacity-100 transition-[opacity,transform] duration-200 [transition-timing-function:ease] starting:opacity-0 motion-reduce:transition-none">
      <div className="absolute inset-0 bg-[rgba(15,15,15,0.6)]" aria-hidden onClick={close} />
      <section
        ref={dialog}
        className="relative z-[1] h-[calc(100%-100px)] max-h-full w-[90vw] max-w-[1512px] overflow-hidden rounded-[12px] bg-white [box-shadow:0_24px_48px_rgba(25,25,25,0.24),0_4px_12px_rgba(25,25,25,0.14),0_0_0_1px_rgba(42,28,0,0.07)] [transform:translateZ(0)_scale(1)] [transition-property:transform] duration-200 [transition-timing-function:ease] starting:[transform:translateZ(0)_scale(0.96)] focus:outline-none motion-reduce:transition-none"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <div className="flex h-full flex-row" role="presentation">
          <aside className="h-full w-[240px] shrink-0 overflow-y-auto bg-[#f9f8f7]" aria-hidden />
          <div className="relative z-[1] h-full min-w-0 grow shrink basis-auto overflow-hidden">
            <div className="absolute top-[12px] right-[12px] size-[22px] rounded-[100%] bg-white">
              <button
                ref={closeButton}
                className="flex size-full shrink-0 cursor-pointer items-center justify-center rounded-[100%] [border:0] bg-transparent p-0 text-[#8e8b86] transition-[background] duration-100 [transition-timing-function:ease-in-out] hover:bg-[rgba(33,27,23,0.05)] active:bg-[rgba(33,27,23,0.1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
                type="button"
                aria-label="Close settings"
                onClick={close}
              >
                <CloseIcon />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}

/** The 16px close mark measured from Notion's live Settings dialog. */
function CloseIcon() {
  return (
    <svg className="size-[14px] shrink-0 fill-current" viewBox="0 0 16 16" aria-hidden>
      <path d="M12.73 4.33a.75.75 0 1 0-1.06-1.06L8 6.94 4.33 3.27a.75.75 0 0 0-1.06 1.06L6.94 8l-3.67 3.67a.75.75 0 1 0 1.06 1.06L8 9.06l3.67 3.67a.75.75 0 0 0 1.06-1.06L9.06 8z" />
    </svg>
  )
}
