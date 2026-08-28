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

/**
 * The most anybody may ask one agent to run at the same time.
 *
 * Two agents on one machine each allowed this many is thirty-two agent processes, and every one of
 * them spawns builds and test runs of its own — which is already past what a laptop does well.
 * Nothing was measured to arrive at it; it is a ceiling under the numbers that would obviously
 * break the machine, so that a typo in a box cannot.
 *
 * The column carries the same bound, and `machine.spec.ts` holds the two to each other: apart,
 * the failure is a value this deployment accepts and the database then refuses — a person told
 * their laptop is broken when what happened is that they typed 20.
 */
export const AT_ONCE_AT_MOST = 16
