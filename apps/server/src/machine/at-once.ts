/**
 * How much one agent takes on at the same time.
 *
 * Its own module because it is a policy, and the two places it would otherwise sit are both wrong:
 * `agent-kind.ts` owns which commands to look for, which is discovery and says nothing about how
 * much anything runs; `db/machine.ts` owns the rows, and a number that a person moves is not a
 * fact about a row.
 */

/**
 * How many pieces of work one agent may run at the same time when nobody has said.
 *
 * A judgement, not a measurement. One is what `04` enforced and it leaves the common machine — a
 * laptop with a single agent on it — no better off than before; two leaves a third piece of work
 * queued behind the promise that it would not be. It is a setting, and the number to look at is
 * whatever people move it to.
 *
 * The column carries the same default, so a row written without one agrees with a machine that
 * has no row at all. `machine.spec.ts` is where the two are held to each other.
 */
export const AT_ONCE_BY_DEFAULT = 3
