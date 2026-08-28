/**
 * What the browser and the server must compute the same answer for.
 *
 * That is the whole rule for what belongs here. Anything one side can compute and the other can
 * be told over the wire goes over the wire — a value in a response is right for the deployment
 * that sent it, while a value compiled into a page is right only until somebody changes one side.
 *
 * Everything here runs in all three places — browser, server, and a machine. Nothing here may
 * import Node, and nothing may import the browser: the name is the entry test, and a module that
 * fails it belongs in the app that needs it.
 */

export { normalizeSlug, nextFreeSlug, type Slug } from './slug.ts'
export { returnPath } from './return-path.ts'
export { fitsInPiece, PIECE, textPieces, utf8Length, type TextPiece } from './piece.ts'
