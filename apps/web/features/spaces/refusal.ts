/**
 * What "that address is held" sounds like, wherever a Space gets named.
 *
 * The refusal arrives as the server wrote it. It used to be stringified into an `Error` and
 * parsed back out of the message here, so rewording a message could change what a screen said
 * about a failure.
 *
 * What is thrown is still not always a refusal: a call that never arrived throws whatever `fetch`
 * threw, and that is not the server saying no. Read as one, it took the whole screen down. So
 * this asks what it has rather than assuming — and says nothing about anything it does not
 * recognise, which leaves the screen to say "that could not be sent".
 */

/** The one refusal with something to add: the address is held, and here is one that is not. */
function held(refused: Readonly<Record<PropertyKey, unknown>>): string | undefined {
  if (typeof refused['suggestion'] !== 'string') return undefined

  return `Somebody holds that address. ${refused['suggestion']} is free — for now.`
}

export function spaceRefusal(refused: unknown): string | undefined {
  if (typeof refused !== 'object' || refused === null) return undefined
  if (!('reason' in refused)) return undefined

  return held(refused) ?? 'That name cannot be used. Try another.'
}
