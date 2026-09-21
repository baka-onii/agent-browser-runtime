// JSON-compatible structured logger (spec §29). Never logs secrets.
import type { BrowserEventPayload } from "./events.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger { info(e: Record<string, unknown>): void; warn(e: Record<string, unknown>): void; error(e: Record<string, unknown>): void; }

const REDACT = new Set(["password", "cookie", "cookies", "authorization", "apiKey", "api_key", "token", "secret"]);

export function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT.has(k.toLowerCase())) { out[k] = "[REDACTED]"; continue; }
    if (typeof v === "string" && /password|secret/i.test(k)) { out[k] = "[REDACTED]"; continue; }
    out[k] = v;
  }
  return out;
}

export function createLogger(sessionId = "sess_01", sink: (line: string) => void = console.log): Logger {
  const emit = (level: string, e: Record<string, unknown>) => {
    sink(JSON.stringify({ timestamp: new Date().toISOString(), sessionId, level, ...sanitize(e) } satisfies Record<string, unknown>));
  };
  return {
    info: (e) => emit("info", e),
    warn: (e) => emit("warn", e),
    error: (e) => emit("error", e),
  };
}

/** Append JSON lines to a file (created on first write). */
export function fileSink(path: string): (line: string) => void {
  return (line: string) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`);
    } catch { /* logging never breaks the runtime */ }
  };
}

/** Fan out to several sinks (e.g. console + file). */
export function teeSink(...sinks: ((line: string) => void)[]): (line: string) => void {
  return (line: string) => {
    for (const s of sinks) { try { s(line); } catch { /* ignore */ } }
  };
}

export function eventToLog(e: BrowserEventPayload): Record<string, unknown> { return sanitize({ ...e }); }
