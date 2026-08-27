/** Join optional class names without bringing a styling framework into this app. */
export function cn(...classes: readonly (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
