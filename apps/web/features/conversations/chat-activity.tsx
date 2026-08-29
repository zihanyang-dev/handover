// The processing row is adapted from Kanna's ProcessingMessage.
// The original copyright and source terms are retained in styles/chat.css.

import { useLayoutEffect, useRef } from 'react'
import { ArrowRepeat } from 'react-bootstrap-icons'
import { AnimatedShinyText } from '../../components/ui/animated-shiny-text.tsx'
import type { LiveOutput, LiveTurn } from './talking.ts'

function latestActivity(moment: LiveTurn['activity']) {
  if (moment === undefined) return 'Working…'
  if (moment.said === 'thinking') return 'Thinking…'
  const detail = moment.arg || moment.name
  return detail === '' ? `${moment.verb}…` : `${moment.verb} ${detail}`
}

/** One live status and its bounded output, without replaying the event stream. */
export function ChatActivity({
  activity,
  output,
}: {
  readonly activity: LiveTurn['activity']
  readonly output: LiveOutput | undefined
}) {
  const outputView = useRef<HTMLPreElement>(null)
  const current = latestActivity(activity)

  useLayoutEffect(() => {
    const element = outputView.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [output?.text])

  return (
    <section className="chat-processing" aria-label="Happening now">
      <div role="status" aria-live="polite" aria-label={current}>
        <ArrowRepeat aria-hidden />
        <AnimatedShinyText className="text-copy-xs" shimmerWidthPx={44}>
          {current}
        </AnimatedShinyText>
      </div>
      {output !== undefined && output.text !== '' && (
        <div className="chat-live-output-wrap">
          {output.truncated && <span>Earlier output unavailable</span>}
          <pre ref={outputView} className="chat-live-output" aria-label="Live tool output">
            <code>{output.text}</code>
          </pre>
        </div>
      )}
    </section>
  )
}
