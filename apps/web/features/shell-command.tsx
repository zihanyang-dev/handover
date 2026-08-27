/**
 * A command to run in a terminal, with a way to take it.
 *
 * Somebody reads this on one screen and types it on another machine, so the thing that matters is
 * that it can be taken whole: retyping a key by eye is how a character goes missing and the answer
 * comes back "that key does not work".
 */

import { useEffect, useRef, useState } from 'react'
import { Check2, Clipboard } from 'react-bootstrap-icons'

export function ShellCommand({ command }: { readonly command: string }) {
  return (
    <div className="shell-snippet">
      <code>
        <span className="shell-prompt" aria-hidden>
          $
        </span>{' '}
        <span>{command}</span>
      </code>
      <Copy text={command} />
    </div>
  )
}

/** Says it copied, then stops saying it — a tick that never clears reads as a stuck button. */
function Copy({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  return (
    <button
      className="shell-copy"
      type="button"
      aria-label={copied ? 'Copied' : 'Copy command'}
      title={copied ? 'Copied' : 'Copy command'}
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
