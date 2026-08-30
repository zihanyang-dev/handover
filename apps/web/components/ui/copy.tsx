/**
 * Taking something whole, rather than by eye.
 *
 * Three screens hand over a string somebody has to use somewhere else — a command to run on
 * another machine, a link to send to another person — and all of them fail the same way if it is
 * retyped: one character goes missing and the answer comes back "that does not work", with
 * nothing to say why.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check2, Clipboard, ExclamationTriangle } from 'react-bootstrap-icons'

/**
 * What the last press did.
 *
 * `failed` is not decoration. Writing to the clipboard is refused outright on an insecure origin
 * and can be refused by permission, and a button that says "Copied" either way hands somebody
 * whatever was in their clipboard before — which they will then paste somewhere and be told is
 * wrong.
 */
type Took = 'nothing yet' | 'copied' | 'failed'

const SAYS_SO_FOR_MS = 1600

function words(took: Took, what: string): string {
  if (took === 'copied') return 'Copied'
  if (took === 'failed') return 'Could not copy'

  return `Copy ${what}`
}

function mark(took: Took): ReactNode {
  if (took === 'copied') return <Check2 aria-hidden />
  if (took === 'failed') return <ExclamationTriangle aria-hidden />

  return <Clipboard aria-hidden />
}

/**
 * Says what it did, then stops saying it — a tick that never clears reads as a stuck button.
 *
 * With `label`, the words are on the button; without, it is the icon alone and the words are its
 * accessible name. The two look nothing alike and behave identically, which is the whole reason
 * this is one component.
 */
export function Copy({
  text,
  what,
  label = false,
}: {
  readonly text: string
  readonly what: string
  readonly label?: boolean
}) {
  const [took, setTook] = useState<Took>('nothing yet')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  const said = words(took, what)
  const say = (result: Took): void => {
    setTook(result)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setTook('nothing yet')
    }, SAYS_SO_FOR_MS)
  }

  return (
    <button
      className={label ? 'shell-copy shell-copy-said' : 'shell-copy'}
      type="button"
      aria-label={label ? undefined : said}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            say('copied')
          },
          () => {
            say('failed')
          },
        )
      }}
    >
      {mark(took)}
      {label && <span>{said}</span>}
    </button>
  )
}
