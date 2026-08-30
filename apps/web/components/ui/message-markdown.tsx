import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Safe GFM for conversation text; raw HTML stays text instead of becoming DOM.
 *
 * Memoized, and this is the one place in the app where that is load-bearing rather than a habit.
 * Every line a person or an agent said is parsed by remark here, and while a turn streams, the
 * screen re-renders on every three-kilobyte piece of output. Without this, a conversation with a
 * hundred replies in it re-parsed a hundred messages per piece — work that grows with how long
 * you have been talking, for output that has nothing to do with any of them.
 *
 * The same thing everybody building one of these arrives at: Vercel's AI SDK cookbook memoizes
 * markdown blocks, Streamdown ships it as the point of the library, and LibreChat did it in
 * `#13576` for exactly this symptom. Ours is simpler than theirs because our streamed text is not
 * markdown at all — what streams is a command's output, in a `pre` — so a whole message is either
 * finished or not yet here, and there are no half-parsed blocks to keep.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  children,
}: {
  readonly children: string
}) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  )
})
