import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

export function readEphemeralRange(filePath = "/proc/sys/net/ipv4/ip_local_port_range") {
  try {
    const [start, end] = fs.readFileSync(filePath, "utf8").trim().split(/\s+/u).map(Number);
    if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) return { start, end };
  } catch {}
  return null;
}

export function candidatePorts({ ephemeralRange = readEphemeralRange(), randomInt = crypto.randomInt } = {}) {
  const all = [];
  for (let port = 49152; port <= 65535; port += 1) all.push(port);
  const preferred = ephemeralRange ? all.filter((p) => p < ephemeralRange.start || p > ephemeralRange.end) : all;
  const secondary = ephemeralRange ? all.filter((p) => p >= ephemeralRange.start && p <= ephemeralRange.end) : [];
  function shuffle(values) {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  return [...shuffle(preferred), ...shuffle(secondary)];
}

export async function bindAvailablePort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => resolve(server));
  });
}

export async function selectPort({ requestedPort, host = "127.0.0.1", ephemeralRange, randomInt } = {}) {
  if (requestedPort !== undefined) {
    const port = Number(requestedPort);
    if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("--port must be in 49152..65535");
    const reservation = await bindAvailablePort(port, host);
    return { port, reservation, ephemeralRange: ephemeralRange || readEphemeralRange() };
  }
  let lastError;
  for (const port of candidatePorts({ ephemeralRange, randomInt }).slice(0, 512)) {
    try {
      const reservation = await bindAvailablePort(port, host);
      return { port, reservation, ephemeralRange: ephemeralRange || readEphemeralRange() };
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`No available private port found${lastError ? `: ${lastError.message}` : ""}`);
}

