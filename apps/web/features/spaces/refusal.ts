/** What "that address is held" sounds like, wherever a Space gets named. */

type Refused = { readonly reason: string; readonly suggestion?: string }

export function spaceRefusal(error: Error | null): string | undefined {
  if (error === null) return undefined

  // A call that never arrived is not the server saying no, and what comes back from a dropped
  // connection is not in the shape a refusal is in. Parsed anyway, it threw — and took the whole
  // screen down with it, which is the one thing worse than the request failing.
  const refused = read(error.message)
  if (refused === undefined) return undefined
  return refused.suggestion === undefined
    ? 'That name cannot be used. Try another.'
    : `Somebody holds that address. ${refused.suggestion} is free — for now.`
}

function read(message: string): Refused | undefined {
  try {
    return JSON.parse(message) as Refused
  } catch {
    return undefined
  }
}
