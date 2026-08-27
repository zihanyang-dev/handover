/**
 * How much of a command's output travels in one live piece.
 *
 * Well under `NOTIFY`'s 8000 bytes once it is JSON with a name beside it, so no piece is ever the
 * one that gets dropped for being too big.
 *
 * Here rather than sent over the wire because it is not a deployment's choice: the limit is
 * Postgres's, the same in every deployment, and both ends have to obey the one number — the
 * machine cuts at it and the server refuses anything longer. `pollSeconds` goes the other way,
 * and it is the difference between the two that decides: a deployment may want to be asked less
 * often, but no deployment may want a different `NOTIFY`.
 */
export const PIECE = 3000
