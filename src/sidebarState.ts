export interface SidebarMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly contextLabel?: string;
  readonly truncated?: boolean;
}

export function limitSidebarMessages(
  messages: readonly SidebarMessage[],
  maxMessages: number,
  maxCharacters: number,
): SidebarMessage[] {
  if (maxMessages <= 0 || maxCharacters <= 0) {
    return [];
  }

  const limited: SidebarMessage[] = [];
  let remainingCharacters = maxCharacters;

  for (const message of messages.slice(-maxMessages).reverse()) {
    if (remainingCharacters <= 0) {
      break;
    }
    const content = message.content.slice(-remainingCharacters);
    const truncated = message.truncated || content.length < message.content.length;
    limited.unshift(truncated ? { ...message, content, truncated: true } : { ...message, content });
    remainingCharacters -= content.length;
  }

  return limited;
}
