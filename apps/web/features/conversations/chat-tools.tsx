import { memo, useState } from 'react'
import { Check2, ChevronRight, FileDiff, X } from 'react-bootstrap-icons'
import type { Message } from './conversation.ts'
import type { LiveOutput } from './watching.ts'

export type ToolMessage = Extract<Message, { readonly role: 'tool' }>

const MAX_COLLAPSED_LINES = 7
const MAX_COLLAPSED_CHARACTERS = 500

/**
 * One step, and whatever it is printing if it is the one printing.
 *
 * Handed its own live output rather than the whole map, which is what lets it be memoized: the map
 * is a new object on every piece that arrives, so a row given the map re-rendered on every piece
 * of every *other* row's output. Given `undefined` — which is what every finished step gets — its
 * props do not change and it does no work at all.
 */
const ToolRow = memo(function ToolRow({
  message,
  liveOutput,
}: {
  readonly message: ToolMessage
  readonly liveOutput: LiveOutput | undefined
}) {
  const [expanded, setExpanded] = useState(liveOutput !== undefined)
  const { arg, name, ok } = message.content
  const label = toolLabel(message)
  const counts = toolCounts(message)

  return (
    <div className="chat-tool-row" data-ok={ok === false ? 'false' : 'true'}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current)
        }}
      >
        <span className="chat-tool-row-icon" aria-hidden>
          {ok === false ? <X /> : <Check2 />}
        </span>
        <span className="chat-tool-row-copy">
          <strong>{label}</strong>
          <span className="chat-tool-chip">{arg || name}</span>
        </span>
        {!counts.changed && <AccordionChevron />}
      </button>
      {counts.changed && (
        <DiffChip
          counts={counts}
          expanded={expanded}
          onToggle={() => {
            setExpanded((current) => !current)
          }}
        />
      )}
      <div
        className="chat-tool-detail"
        data-open={expanded || undefined}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div>
          <ToolOutput message={message} liveOutput={liveOutput} />
        </div>
      </div>
    </div>
  )
})

export function ToolRun({
  messages,
  liveOutputs,
}: {
  readonly messages: readonly ToolMessage[]
  readonly liveOutputs: ReadonlyMap<string, LiveOutput>
}) {
  const hasLiveOutput = messages.some((message) => outputFor(message, liveOutputs) !== undefined)
  const [open, setOpen] = useState(hasLiveOutput)
  const label = `Ran ${String(messages.length)} ${messages.length === 1 ? 'step' : 'steps'}`

  return (
    <div className="chat-tool-run">
      <button
        type="button"
        className="chat-tool-run-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        <span className="chat-tool-run-label">
          {label}
          <AccordionChevron />
        </span>
      </button>
      <div
        className="chat-tool-run-body"
        data-open={open || undefined}
        aria-hidden={!open}
        inert={!open}
      >
        <div>
          <div className="chat-tool-rows">
            {messages.map((message) => (
              <ToolRow
                key={message.seq}
                message={message}
                liveOutput={outputFor(message, liveOutputs)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function toolLabel(message: ToolMessage) {
  const { name, verb } = message.content
  if (/^agent/iu.test(name)) return 'Delegating work'
  if (/toolsearch/iu.test(name)) return 'Finding a tool'
  if (/websearch/iu.test(name)) return 'Searching the web'
  if (/webfetch/iu.test(name)) return 'Fetching a page'
  if (name === 'command_execution' || name === 'Bash') return 'Run'
  return verb || name
}

function outputFor(
  message: ToolMessage,
  liveOutputs: ReadonlyMap<string, LiveOutput>,
): LiveOutput | undefined {
  const { callId } = message.content
  return callId === undefined ? undefined : liveOutputs.get(callId)
}

function ToolOutput({
  message,
  liveOutput,
}: {
  readonly message: ToolMessage
  readonly liveOutput: LiveOutput | undefined
}) {
  const text = outputText(message.content.excerpt, liveOutput)
  if (text === '') return null
  return (
    <ToolDetail
      excerpt={text}
      command={message.content.arg}
      truncated={message.content.truncated === true || liveOutput?.truncated === true}
    />
  )
}

function outputText(durable: string, live: LiveOutput | undefined): string {
  if (live === undefined || live.text === '') return durable
  if (live.truncated && durable.length > live.text.length) return durable
  return live.text
}

function ToolDetail({
  excerpt,
  command,
  truncated = false,
}: {
  readonly excerpt: string
  readonly command: string
  readonly truncated?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const lines = excerpt.split('\n')
  const visibleLines =
    command.trim() !== '' && lines[0]?.trim() === command.trim() ? lines.slice(1) : lines
  const long =
    visibleLines.length > MAX_COLLAPSED_LINES ||
    visibleLines.join('\n').length > MAX_COLLAPSED_CHARACTERS

  return (
    <div className="chat-tool-output" data-clamped={(long && !showAll) || undefined}>
      <span className="chat-tool-output-truncated" hidden={!truncated}>
        Earlier output unavailable
      </span>
      <code>
        {visibleLines.map((line, index) => (
          <span className="chat-tool-output-line" data-tone={toolLineTone(line)} key={index}>
            {line === '' ? ' ' : line}
          </span>
        ))}
      </code>
      {long && (
        <button
          type="button"
          className="chat-tool-show-all"
          aria-expanded={showAll}
          onClick={() => {
            setShowAll((current) => !current)
          }}
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

function toolLineTone(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'delete'
  if (/^(?:✓|✔|passed\b|success\b)/iu.test(line.trim())) return 'success'
  if (/^(?:✗|✘|error\b|failed\b)/iu.test(line.trim())) return 'failure'
  return 'plain'
}

function AccordionChevron() {
  return <ChevronRight className="chat-accordion-chevron" aria-hidden />
}

function DiffChip({
  counts,
  expanded,
  onToggle,
}: {
  readonly counts: ReturnType<typeof toolCounts>
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const file = counts.file

  return (
    <div className="chat-diff-chip-wrap">
      <button
        type="button"
        aria-label={`Show diff for ${file}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <FileDiff className="chat-diff-icon" aria-hidden />
        <span>{file}</span>
        {counts.additions > 0 && <b>+{counts.additions}</b>}
        {counts.deletions > 0 && <i>−{counts.deletions}</i>}
        <AccordionChevron />
      </button>
    </div>
  )
}

function toolCounts(message: ToolMessage) {
  const file = message.content.arg || message.content.name
  if (message.content.name !== 'file_change') {
    return { file, additions: 0, deletions: 0, changed: false }
  }

  const lines = message.content.excerpt.split('\n')
  const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  return { file, additions, deletions, changed: additions > 0 || deletions > 0 }
}
