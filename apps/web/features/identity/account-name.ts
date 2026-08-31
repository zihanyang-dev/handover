/** A chosen account name, or nothing when the account is still using its address as a fallback. */
export function nameUnlessAddress(displayName: string): string | undefined {
  return displayName.includes('@') ? undefined : displayName
}
