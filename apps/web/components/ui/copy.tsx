/**
 * Taking something whole, rather than by eye.
 *
 * Two screens hand over a string somebody has to use somewhere else — a command to run on another
 * machine, a link to send to another person — and both fail the same way if it is retyped: one
 * character goes missing and the answer comes back "that does not work", with nothing to say why.
 */

import { useEffect, useRef, useState } from 'react'
import { Check2, Clipboard } from 'react-bootstrap-icons'

/** Says it copied, then stops saying it — a tick that never clears reads as a stuck button. */
export function Copy({ text, what }: { readonly text: string; readonly what: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  const says = copied ? 'Copied' : `Copy ${what}`

  return (
    <button
      className="shell-copy"
      type="button"
      aria-label={says}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        timer.current = setTimeout(() => {
          setCopied(false)
        }, 1600)
      }}
    >
      {copied ? <Check2 aria-hidden /> : <Clipboard aria-hidden />}
    </button>
  )
}
