// The processing row is adapted from Kanna's ProcessingMessage.
// Copyright (c) 2025 Jake Mor. Licensed under the MIT terms in THIRD_PARTY_NOTICES.md.

import { Loader2 } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
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

  useLayoutEffect(() => {
    const element = outputView.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [output?.text])

  return (
    <section className="chat-processing" aria-label="Happening now">
      <div role="status" aria-live="polite">
        <Loader2 aria-hidden />
        <AnimatedShinyText className="text-copy-xs" shimmerWidth={44}>
          {latestActivity(activity)}
        </AnimatedShinyText>
      </div>
      {output !== undefined && output.text !== '' && (
        <div className="chat-live-output-wrap">
          {output.truncated && <span>Earlier output truncated</span>}
          <pre ref={outputView} className="chat-live-output" aria-label="Live tool output">
            <code>{output.text}</code>
          </pre>
        </div>
      )}
    </section>
  )
}
