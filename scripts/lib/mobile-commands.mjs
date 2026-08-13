function parseCommand(text) {
  const trimmed = String(text || "").trim();
  const [word = ""] = trimmed.split(/\s+/u);
  const command = word.toLowerCase();
  if (command !== "bind") return null;
  return { command, rest: trimmed.slice(word.length).trim() };
}

export function createMobileCommandRouter({ store, operations = {} } = {}) {
  return async function route({ text, channel, senderId, conversationId }) {
    const source = { channel, senderId, conversationId, authorId: "author/default" };
    const parsed = parseCommand(text);

    if (parsed?.command === "bind") {
      if (!parsed.rest || /\s/u.test(parsed.rest)) return "Usage: bind <code>";
      await store.redeemBindingCode(parsed.rest, source);
      await operations.onBound?.(source);
      return "Author bound. CATM will send notifications to this conversation.";
    }
    return null;
  };
}

export { parseCommand };
