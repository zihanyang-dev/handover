/**
 * The most anybody may ask one agent to run at the same time.
 *
 * Here rather than in the server because both sides must reach the same answer: the box on the
 * screen refuses a larger number before it is sent, and the column's check constraint refuses the
 * same one if it ever is. Written twice they drift, and the drift reads to a person as their
 * laptop being broken — the page accepted what they typed and the database then would not.
 *
 * Two agents on one machine each allowed this many is thirty-two agent processes, and every one of
 * them spawns builds and test runs of its own — already past what a laptop does well. Nothing was
 * measured to arrive at it; it is a ceiling under the numbers that would obviously break the
 * machine, so that a typo in a box cannot.
 */
export const AT_ONCE_AT_MOST = 16
