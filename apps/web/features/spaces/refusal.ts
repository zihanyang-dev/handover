/** What "that address is held" sounds like, wherever a Space gets named. */

type Refused = { readonly reason: string; readonly suggestion?: string }

export function spaceRefusal(error: Error | null): string | undefined {
  if (error === null) return undefined
  const refused = JSON.parse(error.message) as Refused
  return refused.suggestion === undefined
    ? 'That name cannot be used. Try another.'
    : `Somebody holds that address. ${refused.suggestion} is free — for now.`
}
