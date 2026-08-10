const HELP = `CATM commands:
sessions
active
current
use S12
send S12 <text>
inbox S12
decisions S12
decide ABC <answer>
new [claude|opencode]
close S12
snap S12
status
bind <code>
help`;

function sessionLine(session) {
  return `${session.sessionId}  ${session.status}  ${session.agent}  ${session.label}${session.unacknowledged ? `  inbox:${session.unacknowledged}` : ""}${session.pendingDecisions ? `  decisions:${session.pendingDecisions}` : ""}`;
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  const [word = ""] = trimmed.split(/\s+/u);
  const command = word.toLowerCase();
  if (!["sessions", "active", "current", "use", "send", "inbox", "decisions", "decide", "new", "close", "snap", "status", "bind", "help"].includes(command)) return null;
  return { command, rest: trimmed.slice(word.length).trim() };
}

export function createMobileCommandRouter({ store, operations = {} }) {
  return async function route({ text, channel, senderId, conversationId }) {
    const source = { channel, senderId, conversationId, authorId: "author/default" };
    const key = `${channel}:${conversationId}`;
    const parsed = parseCommand(text);
    if (parsed?.command === "bind") {
      if (!parsed.rest || /\s/u.test(parsed.rest)) return "Usage: bind <code>";
      await store.redeemBindingCode(parsed.rest, source);
      await operations.onBound?.(source);
      return "Author bound. Use \"sessions\" to list sessions.";
    }
    const enqueue = async (sessionId, body) => {
      if (!body) throw new Error("Instruction text is required");
      const instruction = await store.enqueueInstruction(sessionId, body, source);
      const session = store.getSession(sessionId);
      if (session.managed && operations.inject) {
        await operations.inject(session, body);
        await store.markInstructionAcknowledged(sessionId, instruction.instructionId);
        return `${instruction.instructionId} injected into ${sessionId}.`;
      }
      return `${instruction.instructionId} queued for ${sessionId}.`;
    };
    if (!store.authorBinding(channel, senderId)) return "Author not bound. Use \"bind <code>\".";

    if (!parsed) {
      const current = store.currentSession(key);
      if (!current) return 'No session selected. Use "sessions" and "use S12".';
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
      case "active": {
        const sessions = store.listSessions({ activeOnly: true });
        return sessions.length ? sessions.map(sessionLine).join("\n") : "No active sessions.";
      }
      case "current": {
        const id = store.currentSession(key);
        return id ? sessionLine({ ...store.getSession(id), unacknowledged: store.inbox(id).filter((x) => x.status !== "acknowledged").length, pendingDecisions: store.listDecisions(id).length }) : 'No session selected. Use "sessions" and "use S12".';
      }
      case "use": {
        const id = oneSessionId();
        await store.setCurrentSession(key, id);
        return `Selected ${id}.`;
      }
      case "send": {
        const match = /^(S\d+)\s+([\s\S]+)$/iu.exec(parsed.rest);
        if (!match) throw new Error("Usage: send S12 <text>");
        return enqueue(match[1].toUpperCase(), match[2].trim());
      }
      case "inbox": {
        const id = oneSessionId();
        const items = store.inbox(id);
        return items.length ? items.map((item) => `${item.instructionId}  ${item.status}  ${item.text}`).join("\n") : `Inbox ${id} is empty.`;
      }
      case "decisions": {
        const id = oneSessionId();
        const items = store.listDecisions(id);
        return items.length ? items.map((item) => `${item.shortCode}  ${item.question}`).join("\n") : `No pending decisions for ${id}.`;
      }
      case "decide": {
        const match = /^(\w+)\s+([\s\S]+)$/u.exec(parsed.rest);
        if (!match) throw new Error("Usage: decide ABC <answer>");
        const decision = await store.answerDecision(match[1], match[2].trim(), source);
        return decision.alreadyClosed ? `Decision ${decision.shortCode} was already answered.` : `Decision ${decision.shortCode} answered.`;
      }
      case "new": {
        const agent = (parsed.rest || "codex").toLowerCase();
        if (!["codex", "claude", "opencode"].includes(agent)) throw new Error("Usage: new [claude|opencode]");
        if (!operations.createSession) throw new Error("Managed session creation is unavailable");
        const session = await operations.createSession(agent);
        await store.setCurrentSession(key, session.sessionId);
        return `Started ${session.sessionId} (${agent}) and selected it.`;
      }
      case "close": {
        const id = oneSessionId();
        const session = store.getSession(id);
        await operations.close?.(session);
        await store.closeSession(id);
        await store.clearCurrentSession(key, id);
        return `Closed ${id}.`;
      }
      case "snap": {
        const session = store.getSession(oneSessionId());
        if (!session.managed || !operations.snapshot) throw new Error("Snapshot is only available for managed sessions");
        return await operations.snapshot(session);
      }
      case "status": return await operations.status?.() || "CATM is ready.";
      case "help": return HELP;
      default: throw new Error("Unsupported command");
    }
  };
}

export { HELP, parseCommand };
