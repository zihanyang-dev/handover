import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Safe GFM for conversation text; raw HTML stays text instead of becoming DOM. */
export function MessageMarkdown({ children }: { readonly children: string }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  )
}
