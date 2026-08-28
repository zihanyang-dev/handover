import { describe, expect, it } from 'vitest'
import { fitsInPiece, PIECE, textPieces, utf8Length } from './piece.ts'

describe('live text pieces', () => {
  it('bounds UTF-8 bytes rather than JavaScript characters', () => {
    const text = '界'.repeat(PIECE)
    const pieces = textPieces(text)

    expect(pieces).toHaveLength(3)
    expect(pieces.every((piece) => fitsInPiece(piece.text))).toBe(true)
    expect(pieces.map((piece) => piece.at)).toEqual([0, 1000, 2000])
    expect(pieces.map((piece) => piece.text).join('')).toBe(text)
  })

  it('does not split a surrogate pair and keeps UTF-16 offsets', () => {
    const text = `${'a'.repeat(PIECE - 1)}🙂then`
    const pieces = textPieces(text, 7)

    expect(pieces.map((piece) => piece.at)).toEqual([7, PIECE + 6])
    expect(pieces.map((piece) => piece.text).join('')).toBe(text)
    expect(utf8Length(pieces[0]?.text ?? '')).toBe(PIECE - 1)
  })
})
