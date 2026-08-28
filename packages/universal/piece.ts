/** PostgreSQL leaves enough room around one output fragment for its JSON envelope. */
export const PIECE = 3000

export type TextPiece = {
  readonly at: number
  readonly text: string
}

/** The UTF-8 bytes a string occupies across the machine, server, and browser. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (const character of text) bytes += bytesIn(character)
  return bytes
}

/** Whether one fragment fits the bound used before `pg_notify`. */
export function fitsInPiece(text: string): boolean {
  return utf8Length(text) <= PIECE
}

/** Splits at code-point boundaries while retaining the browser's UTF-16 replacement offset. */
export function textPieces(text: string, beginsAt = 0): readonly TextPiece[] {
  const pieces: TextPiece[] = []
  let start = 0
  let cursor = 0
  let bytes = 0

  for (const character of text) {
    const nextBytes = bytes + bytesIn(character)
    if (nextBytes > PIECE && cursor > start) {
      pieces.push({ at: beginsAt + start, text: text.slice(start, cursor) })
      start = cursor
      bytes = 0
    }

    cursor += character.length
    bytes += bytesIn(character)
  }

  if (start < text.length) pieces.push({ at: beginsAt + start, text: text.slice(start) })
  return pieces
}

function bytesIn(character: string): number {
  const point = character.codePointAt(0)
  if (point === undefined || point <= 0x7f) return 1
  if (point <= 0x7ff) return 2
  if (point <= 0xffff) return 3
  return 4
}
