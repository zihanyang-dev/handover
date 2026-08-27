/**
 * A command to run in a terminal, with a way to take it.
 *
 * Somebody reads this on one screen and types it on another machine, so the thing that matters is
 * that it can be taken whole: retyping a key by eye is how a character goes missing and the answer
 * comes back "that key does not work".
 */

import { Copy } from './copy.tsx'

export function ShellCommand({ command }: { readonly command: string }) {
  return (
    <div className="shell-snippet">
      <code>
        <span className="shell-prompt" aria-hidden>
          $
        </span>{' '}
        <span>{command}</span>
      </code>
      <Copy text={command} what="command" />
    </div>
  )
}
