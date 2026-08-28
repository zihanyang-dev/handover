const arriving = new Set<string>()

/** The first user bubble belongs to the composer-to-conversation transition in this SPA visit. */
export function markMessageArrival(conversationId: string) {
  arriving.add(conversationId)
}

export function consumeMessageArrival(conversationId: string) {
  const marked = arriving.has(conversationId)
  arriving.delete(conversationId)
  return marked
}
