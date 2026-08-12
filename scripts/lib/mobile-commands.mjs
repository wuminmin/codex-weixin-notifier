const HELP = `CATM commands:
sessions
use S12
send S12 <text>
decide ABC <answer>
close S12
status
bind <code>
help

When a decision is pending, reply with the answer directly.`;

function sessionLine(session) {
  return `${session.sessionId}  ${session.status}  ${session.agent}  ${session.label}${session.unacknowledged ? `  inbox:${session.unacknowledged}` : ""}${session.pendingDecisions ? `  decisions:${session.pendingDecisions}` : ""}`;
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  const [word = ""] = trimmed.split(/\s+/u);
  const command = word.toLowerCase();
  if (!["sessions", "use", "send", "decide", "close", "status", "bind", "help"].includes(command)) return null;
  return { command, rest: trimmed.slice(word.length).trim() };
}

export function createMobileCommandRouter({ store, operations = {}, waitRegistry } = {}) {
  return async function route({ text, channel, senderId, conversationId }) {
    const source = { channel, senderId, conversationId, authorId: "author/default" };
    const conversationKey = `${channel}:${conversationId}`;
    const parsed = parseCommand(text);

    if (parsed?.command === "bind") {
      if (!parsed.rest || /\s/u.test(parsed.rest)) return "Usage: bind <code>";
      await store.redeemBindingCode(parsed.rest, source);
      await operations.onBound?.(source);
      return 'Author bound. Use "sessions" to list sessions.';
    }
    if (!store.authorBinding(channel, senderId)) return 'Author not bound. Use "bind <code>".';

    const answer = async (decision, raw) => {
      const answered = await store.answerDecision(decision.decisionId, raw, source);
      if (answered.alreadyClosed) return `Decision ${answered.shortCode} was already answered.`;
      const active = Number(waitRegistry?.signal(store.tenantId, answered.decisionId) || 0) > 0;
      return active
        ? `Decision ${answered.shortCode} recorded. Claude wait is active and will continue.`
        : `Decision ${answered.shortCode} recorded. No active Claude wait; reopen Claude to continue.`;
    };

    const enqueue = async (sessionId, body) => {
      if (!body) throw new Error("Instruction text is required");
      const instruction = await store.enqueueInstruction(sessionId, body, source);
      return `${instruction.instructionId} queued for ${String(sessionId).toUpperCase()}.`;
    };

    if (!parsed) {
      const decision = store.pendingDecisionForConversation(conversationKey);
      if (decision) return answer(decision, String(text || "").trim());
      const current = store.currentSession(conversationKey);
      if (!current) return 'No decision or session selected. Use "sessions" and "use S12".';
      return enqueue(current, String(text || "").trim());
    }

    const oneSessionId = () => {
      const id = parsed.rest.toUpperCase();
      if (!/^S\d+$/u.test(id)) throw new Error(`Usage: ${parsed.command} S12`);
      return id;
    };

    switch (parsed.command) {
      case "sessions": {
        const sessions = store.listSessions();
        return sessions.length ? sessions.map(sessionLine).join("\n") : "No sessions.";
      }
      case "use": {
        const id = oneSessionId();
        await store.setCurrentSession(conversationKey, id);
        return `Selected ${id}.`;
      }
      case "send": {
        const match = /^(S\d+)\s+([\s\S]+)$/iu.exec(parsed.rest);
        if (!match) throw new Error("Usage: send S12 <text>");
        return enqueue(match[1], match[2].trim());
      }
      case "decide": {
        const match = /^(\w+)\s+([\s\S]+)$/u.exec(parsed.rest);
        if (!match) throw new Error("Usage: decide ABC <answer>");
        return answer(store.getDecision(match[1]), match[2].trim());
      }
      case "close": {
        const id = oneSessionId();
        await store.closeSession(id);
        await store.clearCurrentSession(conversationKey, id);
        return `Closed ${id}.`;
      }
      case "status": return await operations.status?.() || "CATM is ready.";
      case "help": return HELP;
      default: throw new Error("Unsupported command");
    }
  };
}

export { HELP, parseCommand };
