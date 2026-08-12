function keyOf(tenantId, decisionId) {
  return `${String(tenantId || "").toLowerCase()}:${String(decisionId || "").toUpperCase()}`;
}

export class DecisionWaitRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(tenantId, decisionId) {
    const key = keyOf(tenantId, decisionId);
    const entry = this.entries.get(key) || { registrations: new Set(), listeners: new Set() };
    const registration = Symbol(key);
    entry.registrations.add(registration);
    this.entries.set(key, entry);
    let closed = false;
    return {
      wait: (timeoutMs, signal) => new Promise((resolve) => {
        if (closed || signal?.aborted) return resolve("cancelled");
        let timer;
        const finish = (reason) => {
          clearTimeout(timer);
          entry.listeners.delete(finish);
          signal?.removeEventListener("abort", onAbort);
          resolve(reason);
        };
        const onAbort = () => finish("cancelled");
        entry.listeners.add(finish);
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => finish("timeout"), Math.max(1, Number(timeoutMs || 1)));
      }),
      close: () => {
        if (closed) return;
        closed = true;
        entry.registrations.delete(registration);
        if (!entry.registrations.size && !entry.listeners.size) this.entries.delete(key);
      },
    };
  }

  signal(tenantId, decisionId) {
    const entry = this.entries.get(keyOf(tenantId, decisionId));
    if (!entry) return 0;
    const listeners = [...entry.listeners];
    listeners.forEach((finish) => finish("signalled"));
    return entry.registrations.size;
  }

  isActive(tenantId, decisionId) {
    return (this.entries.get(keyOf(tenantId, decisionId))?.registrations.size || 0) > 0;
  }
}
