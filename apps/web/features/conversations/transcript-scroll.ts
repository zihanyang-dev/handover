// Adapted from Kanna's transcriptScrollAnchors.ts.
// Copyright (c) 2025 Jake Mor. Licensed under the MIT terms in THIRD_PARTY_NOTICES.md.

export type TranscriptRow = {
  readonly id: string
  readonly kind: 'user' | 'reply'
  readonly seq: number
}

export type LatestUserPrompt = {
  readonly messageId: string
  readonly rowId: string
  readonly seq: number
}

/** The most recent user prompt, which is the row a new turn grows beneath. */
export function getLatestUserPrompt(rows: readonly TranscriptRow[]): LatestUserPrompt | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.kind !== 'user') continue
    return { messageId: String(row.seq), rowId: row.id, seq: row.seq }
  }
  return null
}

/**
 * Whether the latest prompt changed because the user just sent something.
 * Streaming rows and older history leave the latest prompt untouched, so they
 * never fight the reader's scroll position.
 */
export function shouldPinForNewPrompt(
  previous: LatestUserPrompt | null,
  next: LatestUserPrompt | null,
): boolean {
  if (next === null || previous === null) return false
  return previous.messageId !== next.messageId
}
