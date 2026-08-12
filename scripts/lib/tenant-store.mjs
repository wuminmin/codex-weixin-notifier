import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateDir, readJson, writeJson, withFileLock } from "./atomic-json.mjs";
import { tenantStateDir, validateTenantId } from "./catm-config.mjs";

const AGENTS = new Set(["codex", "claude", "opencode"]);
const STATUSES = new Set(["working", "verifying", "waiting_author", "queued", "idle", "stale", "closed"]);
const now = () => new Date().toISOString();

function cleanText(value, max, name) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new Error(`${name} must contain 1..${max} characters`);
  return text;
}

function tenantFiles(paths, tenantId) {
  const root = tenantStateDir(paths, validateTenantId(tenantId));
  return {
    root,
    lock: path.join(root, ".state.lock"),
    state: path.join(root, "registry.json"),
  };
}

function emptyState(tenantId) {
  return {
    version: 1,
    tenantId,
    counters: { session: 0, instruction: 0, decision: 0 },
    sessions: {},
    inbox: {},
    decisions: {},
    completions: {},
    authors: {},
    conversations: {},
    bindingCodes: {},
    updatedAt: now(),
  };
}

function normalizeState(state, tenantId) {
  if (!state) return emptyState(tenantId);
  if (state.version !== 1 || state.tenantId !== tenantId) throw new Error(`Invalid tenant registry: ${tenantId}`);
  return state;
}

function pendingDecisions(state, sessionId) {
  return Object.values(state.decisions).filter((item) => item.sessionId === sessionId && item.status === "pending");
}

function activeSession(session) {
  return ["working", "verifying", "waiting_author", "queued", "stale"].includes(session.status);
}

export class TenantStore {
  constructor({ paths, tenantId }) {
    this.paths = paths;
    this.tenantId = validateTenantId(tenantId);
    this.files = tenantFiles(paths, tenantId);
    ensurePrivateDir(this.files.root);
  }

  read() {
    return normalizeState(readJson(this.files.state), this.tenantId);
  }

  async mutate(fn) {
    return withFileLock(this.files.lock, async () => {
      const state = this.read();
      const result = await fn(state);
      state.updatedAt = now();
      writeJson(this.files.state, state, 0o600);
      return result;
    });
  }

  async syncSession(input) {
    return this.mutate((state) => {
      const agent = String(input.agent || "").toLowerCase();
      const status = String(input.status || "working").toLowerCase();
      if (!AGENTS.has(agent)) throw new Error("agent must be codex, claude, or opencode");
      if (!STATUSES.has(status) || status === "closed") throw new Error("invalid sync status");
      const workspace = cleanText(input.workspace, 4096, "workspace");
      const label = cleanText(input.label, 160, "label");
      const stage = cleanText(input.stage, 500, "stage");
      let session;
      if (input.session_id) {
        session = state.sessions[String(input.session_id).toUpperCase()];
        if (!session || session.status === "closed") throw new Error("session not found");
      }
      if (!session) {
        const sessionId = `S${++state.counters.session}`;
        session = {
          tenantId: this.tenantId,
          sessionId,
          agent,
          workspace,
          label,
          status: "working",
          stage,
          workCycle: 1,
          createdAt: now(),
          lastSyncAt: now(),
        };
        state.sessions[sessionId] = session;
        state.inbox[sessionId] = [];
      }
      if (session.agent !== agent) throw new Error("session agent cannot change");
      if (session.status === "idle" && status !== "idle") session.workCycle += 1;
      session.workspace = workspace;
      session.label = label;
      session.stage = stage;
      session.status = pendingDecisions(state, session.sessionId).length > 0 && status !== "idle" ? "waiting_author" : status;
      session.lastSyncAt = now();
      const ack = new Set((input.acknowledged_instruction_ids || []).map(String));
      const inbox = state.inbox[session.sessionId] || [];
      for (const item of inbox) {
        if (ack.has(item.instructionId) && item.status !== "acknowledged") {
          item.status = "acknowledged";
          item.acknowledgedAt = now();
        }
      }
      const deliver = inbox.filter((item) => item.status !== "acknowledged");
      for (const item of deliver) {
        if (item.status === "queued") {
          item.status = "delivered";
          item.deliveredAt = now();
        }
      }
      return {
        session_id: session.sessionId,
        work_cycle_id: `W${session.workCycle}`,
        status: session.status,
        instructions: deliver.map((item) => ({
          instruction_id: item.instructionId,
          sequence: item.sequence,
          text: item.text,
          created_at: item.createdAt,
          delivery_status: item.status,
        })),
        pending_decisions: pendingDecisions(state, session.sessionId).length,
      };
    });
  }

  listSessions({ activeOnly = false } = {}) {
    const state = this.read();
    const staleCutoff = Date.now() - 5 * 60_000;
    return Object.values(state.sessions)
      .map((session) => {
        const stale = activeSession(session) && Date.parse(session.lastSyncAt || "") < staleCutoff;
        const inbox = state.inbox[session.sessionId] || [];
        return {
          ...session,
          status: stale ? "stale" : session.status,
          unacknowledged: inbox.filter((item) => item.status !== "acknowledged").length,
          pendingDecisions: pendingDecisions(state, session.sessionId).length,
        };
      })
      .filter((session) => session.status !== "closed" && (!activeOnly || activeSession(session)))
      .sort((a, b) => Date.parse(b.lastSyncAt || b.createdAt) - Date.parse(a.lastSyncAt || a.createdAt));
  }

  getSession(sessionId) {
    const state = this.read();
    const session = state.sessions[String(sessionId || "").toUpperCase()];
    if (!session || session.status === "closed") throw new Error("session not found");
    return session;
  }

  async enqueueInstruction(sessionId, text, source = {}) {
    return this.mutate((state) => {
      const id = String(sessionId || "").toUpperCase();
      const session = state.sessions[id];
      if (!session || session.status === "closed") throw new Error("session not found");
      const instruction = {
        tenantId: this.tenantId,
        sessionId: id,
        instructionId: `I${++state.counters.instruction}`,
        sequence: (state.inbox[id]?.at(-1)?.sequence || 0) + 1,
        text: cleanText(text, 8000, "instruction"),
        status: "queued",
        source: {
          channel: String(source.channel || "mobile"),
          conversationId: String(source.conversationId || ""),
          authorId: String(source.authorId || "author/default"),
        },
        createdAt: now(),
      };
      state.inbox[id] ||= [];
      state.inbox[id].push(instruction);
      if (session.status === "idle") {
        session.workCycle += 1;
        session.status = "queued";
      }
      return instruction;
    });
  }

  inbox(sessionId) {
    this.getSession(sessionId);
    return this.read().inbox[String(sessionId).toUpperCase()] || [];
  }

  async closeSession(sessionId) {
    return this.mutate((state) => {
      const session = state.sessions[String(sessionId || "").toUpperCase()];
      if (!session || session.status === "closed") throw new Error("session not found");
      session.status = "closed";
      session.closedAt = now();
      for (const decision of pendingDecisions(state, session.sessionId)) {
        decision.status = "cancelled";
        decision.cancelledAt = now();
      }
      return session;
    });
  }

  async createDecision(input) {
    return this.mutate((state) => {
      const sessionId = String(input.session_id || "").toUpperCase();
      const session = state.sessions[sessionId];
      if (!session || session.status === "closed") throw new Error("session not found");
      const idempotencyKey = cleanText(input.idempotency_key, 200, "idempotency_key");
      const previous = Object.values(state.decisions).find((item) => item.sessionId === sessionId && item.idempotencyKey === idempotencyKey);
      if (previous) return { ...previous, deduplicated: true };
      const ordinal = ++state.counters.decision;
      const decisionId = `D${ordinal}`;
      const shortCode = ordinal.toString(36).toUpperCase().padStart(3, "0");
      const options = Array.isArray(input.options) ? input.options.map((item, index) => ({
        id: cleanText(item.id || String(index + 1), 32, "option.id"),
        label: cleanText(item.label, 200, "option.label"),
        description: String(item.description || "").trim().slice(0, 500),
      })) : [];
      if (options.length > 0 && (options.length < 2 || options.length > 5)) throw new Error("options must contain 2..5 entries");
      const decision = {
        tenantId: this.tenantId,
        decisionId,
        shortCode,
        sessionId,
        idempotencyKey,
        question: cleanText(input.question, 2000, "question"),
        context: String(input.context || "").trim().slice(0, 4000),
        recommendation: String(input.recommendation || "").trim().slice(0, 1000),
        allowFreeText: input.allow_free_text !== false,
        options,
        status: "pending",
        delivery: [],
        createdAt: now(),
      };
      state.decisions[decisionId] = decision;
      session.status = "waiting_author";
      return decision;
    });
  }

  async recordDecisionDelivery(decisionId, delivery) {
    return this.mutate((state) => {
      const decision = state.decisions[String(decisionId || "").toUpperCase()];
      if (!decision) throw new Error("decision not found");
      decision.delivery = delivery;
      decision.deliveredAt = now();
      for (const item of delivery || []) {
        if (!item.ok || !item.channel || !item.conversationId) continue;
        const key = `${item.channel}:${item.conversationId}`;
        state.conversations[key] = { ...(state.conversations[key] || {}), pendingDecisionId: decision.decisionId, updatedAt: now() };
      }
      return decision;
    });
  }

  getDecision(idOrCode) {
    const key = String(idOrCode || "").toUpperCase();
    const state = this.read();
    const decision = state.decisions[key] || Object.values(state.decisions).find((item) => item.shortCode === key);
    if (!decision) throw new Error("decision not found");
    return decision;
  }

  listDecisions(sessionId, status = "pending") {
    this.getSession(sessionId);
    return Object.values(this.read().decisions).filter((item) => item.sessionId === String(sessionId).toUpperCase() && (!status || item.status === status));
  }

  pendingDecisionForConversation(conversationKey) {
    const state = this.read();
    const decisionId = state.conversations[String(conversationKey || "")]?.pendingDecisionId;
    const decision = decisionId ? state.decisions[decisionId] : null;
    return decision?.status === "pending" ? decision : null;
  }

  async answerDecision(idOrCode, answer, source = {}) {
    return this.mutate((state) => {
      const key = String(idOrCode || "").toUpperCase();
      const decision = state.decisions[key] || Object.values(state.decisions).find((item) => item.shortCode === key);
      if (!decision) throw new Error("decision not found");
      if (decision.status !== "pending") return { ...decision, alreadyClosed: true };
      const raw = cleanText(answer, 4000, "answer");
      let optionId = "";
      const numeric = /^\d+$/u.test(raw) ? Number(raw) : 0;
      const option = decision.options.find((item, index) => item.id.toLowerCase() === raw.toLowerCase() || index + 1 === numeric);
      if (option) optionId = option.id;
      else if (decision.options.length && !decision.allowFreeText) throw new Error("answer must select one of the listed options");
      decision.status = "answered";
      decision.answer = {
        text: raw,
        optionId,
        authorId: String(source.authorId || "author/default"),
        channel: String(source.channel || "mobile"),
        conversationId: String(source.conversationId || ""),
        answeredAt: now(),
      };
      for (const conversation of Object.values(state.conversations)) {
        if (conversation.pendingDecisionId === decision.decisionId) delete conversation.pendingDecisionId;
      }
      const session = state.sessions[decision.sessionId];
      if (session && pendingDecisions(state, session.sessionId).length === 0) session.status = "working";
      return decision;
    });
  }

  async completeWork(input) {
    return this.mutate((state) => {
      const sessionId = String(input.session_id || "").toUpperCase();
      const session = state.sessions[sessionId];
      if (!session || session.status === "closed") throw new Error("session not found");
      if (pendingDecisions(state, sessionId).length > 0) throw new Error("cannot complete work while author decisions are pending");
      const expected = `W${session.workCycle}`;
      if (String(input.work_cycle_id || "").toUpperCase() !== expected) throw new Error(`work_cycle_id must be ${expected}`);
      const key = `${sessionId}:${expected}`;
      if (state.completions[key]) return { ...state.completions[key], deduplicated: true };
      const completion = {
        tenantId: this.tenantId,
        sessionId,
        workCycleId: expected,
        summary: cleanText(input.summary, 12000, "summary"),
        verification: String(input.verification || "").trim().slice(0, 4000),
        delivery: [],
        createdAt: now(),
      };
      state.completions[key] = completion;
      session.status = "idle";
      session.stage = "Waiting for more instructions";
      session.lastSyncAt = now();
      return completion;
    });
  }

  async recordCompletionDelivery(sessionId, workCycleId, delivery) {
    return this.mutate((state) => {
      const key = `${String(sessionId).toUpperCase()}:${String(workCycleId).toUpperCase()}`;
      const completion = state.completions[key];
      if (!completion) throw new Error("completion not found");
      completion.delivery = delivery;
      completion.deliveredAt = now();
      return completion;
    });
  }

  async bindAuthor({ authorId = "author/default", channel, senderId, conversationId }) {
    return this.mutate((state) => {
      const binding = {
        tenantId: this.tenantId,
        authorId,
        channel: cleanText(channel, 64, "channel"),
        senderId: cleanText(senderId, 256, "sender_id"),
        conversationId: cleanText(conversationId, 256, "conversation_id"),
        boundAt: now(),
      };
      state.authors[`${channel}:${senderId}`] = binding;
      return binding;
    });
  }

  authorBinding(channel, senderId) {
    return this.read().authors[`${channel}:${senderId}`] || null;
  }

  async setCurrentSession(conversationKey, sessionId) {
    return this.mutate((state) => {
      const id = String(sessionId || "").toUpperCase();
      if (!state.sessions[id] || state.sessions[id].status === "closed") throw new Error("session not found");
      state.conversations[conversationKey] = { ...(state.conversations[conversationKey] || {}), sessionId: id, updatedAt: now() };
      return id;
    });
  }

  currentSession(conversationKey) {
    return this.read().conversations[conversationKey]?.sessionId || "";
  }

  async clearCurrentSession(conversationKey, sessionId = "") {
    return this.mutate((state) => {
      const selected = state.conversations[conversationKey]?.sessionId || "";
      if (!sessionId || selected === String(sessionId).toUpperCase()) {
        delete state.conversations[conversationKey]?.sessionId;
        if (state.conversations[conversationKey] && !Object.keys(state.conversations[conversationKey]).some((key) => key !== "updatedAt")) delete state.conversations[conversationKey];
      }
      return selected;
    });
  }

  async createBindingCode({ ttlSeconds = 900 } = {}) {
    const code = crypto.randomBytes(5).toString("base64url").replace(/[^A-Z0-9]/giu, "").toUpperCase().slice(0, 8).padEnd(8, "X");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    await this.mutate((state) => {
      state.bindingCodes ||= {};
      state.bindingCodes[codeHash] = { tenantId: this.tenantId, authorId: "author/default", expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), usedAt: null };
    });
    return { code, tenantId: this.tenantId, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async redeemBindingCode(code, source) {
    return this.mutate((state) => {
      const codeHash = crypto.createHash("sha256").update(String(code || "").trim().toUpperCase()).digest("hex");
      const record = state.bindingCodes?.[codeHash];
      if (!record || record.usedAt || Date.parse(record.expiresAt) <= Date.now()) throw new Error("invalid or expired binding code");
      record.usedAt = now();
      const binding = {
        tenantId: this.tenantId,
        authorId: record.authorId,
        channel: cleanText(source.channel, 64, "channel"),
        senderId: cleanText(source.senderId, 256, "sender_id"),
        conversationId: cleanText(source.conversationId, 256, "conversation_id"),
        boundAt: now(),
      };
      state.authors[`${binding.channel}:${binding.senderId}`] = binding;
      return binding;
    });
  }
}
