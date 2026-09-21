// Direct CDP transport via `ws` (no browser-harness runtime dep). Spec §§3,20,24.
// Supports attach (existing Chrome w/ remote debugging) + managed (launch isolated profile).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { ConnectionError } from "./errors.js";
import type { BrowserConfig } from "./config.js";

export interface RawTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  sendSession(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(sessionId: string, expression: string, awaitPromise?: boolean): Promise<unknown>;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; sessionId?: string; }

export interface CdpEvent { method: string; sessionId?: string; params?: Record<string, unknown>; }
export type CdpEventHandler = (e: CdpEvent) => void;

export class CdpTransport implements RawTransport {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, Pending>();
  private child: ChildProcess | null = null;
  private debugPort: number;
  readonly config: BrowserConfig;

  constructor(config: BrowserConfig, debugPort: number) {
    this.config = config;
    this.debugPort = debugPort;
  }

  static async connect(config: BrowserConfig): Promise<CdpTransport> {
    if (config.mode === "managed") return CdpTransport.launch(config);
    return CdpTransport.attach(config);
  }

  static async attach(config: BrowserConfig): Promise<CdpTransport> {
    const port = config.browser?.remoteDebugPort ?? 9222;
    const timeout = config.connectTimeoutMs ?? 15_000;
    if (config.browser?.wsUrl) {
      const t = new CdpTransport(config, port);
      await t.open(config.browser.wsUrl);
      return t;
    }
    // Resolve browser ws via /json/version
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new ConnectionError(
        `No debuggable Chrome on port ${port}. Run: abr chrome --port ${port}  (or launch Chrome with --remote-debugging-port=${port})`);
    }
    if (!res.ok) throw new ConnectionError(
      `No debuggable Chrome on port ${port}. Run: abr chrome --port ${port}  (or launch Chrome with --remote-debugging-port=${port})`);
    const info = (await res.json()) as { webSocketDebuggerUrl: string };
    const t = new CdpTransport(config, port);
    await t.open(info.webSocketDebuggerUrl);
    return t;
  }

  static async launch(config: BrowserConfig): Promise<CdpTransport> {
    const port = config.browser?.remoteDebugPort ?? 0; // 0 => pick free
    const actualPort = port === 0 ? await freePort() : port;
    const exe = config.browser?.executablePath ?? findChrome() ?? (process.platform === "win32" ? "chrome" : "google-chrome");
    const profileDir = config.browser?.profileDir ?? mkdtempSync(join(tmpdir(), "abr-profile-"));
    const args = [
      `--remote-debugging-port=${actualPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check",
      // Stealth launch hygiene: engine-level webdriver removal (beats JS patching),
      // new headless runs the full browser so the JS surface matches headed Chrome.
      "--disable-blink-features=AutomationControlled",
      ...(config.proxy?.server ? [`--proxy-server=${config.proxy.server}`] : []),
      ...(config.locale ? [`--lang=${config.locale}`] : []),
      ...(config.headless === false ? [] : ["--headless=new"]),
      ...(config.browser?.args ?? []),
    ];
    if (config.stealth === false) {
      const i = args.indexOf("--disable-blink-features=AutomationControlled");
      if (i >= 0) args.splice(i, 1);
    }
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { stdio: "ignore", detached: false });
    } catch (e) {
      throw new ConnectionError(`${chromeHelp()} (spawn failed: ${(e as Error).message})`);
    }
    const state: { spawnError: unknown } = { spawnError: null };
    child.on("error", (e: Error) => { state.spawnError = e; });
    const t = new CdpTransport(config, actualPort);
    t.child = child;
    // Poll /json/version until up (configurable budget, default 15s)
    const deadline = Date.now() + (config.connectTimeoutMs ?? 15_000);
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      if (state.spawnError) throw new ConnectionError(`${chromeHelp()} (${(state.spawnError as Error).message})`);
      try {
        const res = await fetch(`http://127.0.0.1:${actualPort}/json/version`);
        if (res.ok) {
          const info = (await res.json()) as { webSocketDebuggerUrl: string };
          await t.open(info.webSocketDebuggerUrl);
          return t;
        }
      } catch (e) { lastErr = e; }
      await sleep(150);
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new ConnectionError(`Chromium exited code ${child.exitCode}: ${String(lastErr)}`);
      }
    }
    child.kill();
    throw new ConnectionError(`Timed out waiting for Chromium on port ${actualPort}: ${String(lastErr)}`);
  }

  private open(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
      this.ws.once("open", () => {
        this.ws.on("message", (data) => this.onMessage(String(data)));
        resolve();
      });
      this.ws.once("error", reject);
    });
  }

  private onMessage(data: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; sessionId?: string; params?: unknown };
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      // Browser/session event (Target.*, Page.*, Browser.downloadProgress, ...).
      for (const h of this.eventHandlers) {
        try { h({ method: msg.method, sessionId: msg.sessionId, params: (msg.params ?? {}) as Record<string, unknown> }); }
        catch { /* listener errors never break transport */ }
      }
    }
  }

  private eventHandlers = new Set<CdpEventHandler>();
  /** Subscribe to raw CDP events (dialogs, downloads, target lifecycle). */
  onEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => { this.eventHandlers.delete(handler); };
  }

  private call(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 25_000): Promise<unknown> {
    this.id += 1;
    const id = this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sessionId });
      this.ws.send(JSON.stringify(payload), (err) => { if (err) { this.pending.delete(id); reject(err); } });
      // Per-call budget: callers doing wall-clock loops (page settle polls)
      // must pass a SHORT timeout, or each 25s expiry multiplies into
      // minutes of apparent hang on a busy renderer.
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, timeoutMs);
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.config.allowRawCdp === false) {
      const { PermissionError } = await import("./errors.js");
      throw new PermissionError("Raw CDP disabled by policy (allowRawCdp=false)");
    }
    return this.call(method, params);
  }

  async sendSession(sessionId: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<unknown> {
    if (this.config.allowRawCdp === false) {
      const { PermissionError } = await import("./errors.js");
      throw new PermissionError("Raw CDP disabled by policy (allowRawCdp=false)");
    }
    return this.call(method, params, sessionId, timeoutMs);
  }

  async evaluate(sessionId: string, expression: string, awaitPromise = false, timeoutMs = 25_000): Promise<unknown> {
    const res = (await this.call("Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise }, sessionId, timeoutMs)) as
      { exceptionDetails?: { text?: string; exception?: { description?: string } }; result?: { value?: unknown } };
    if (res?.exceptionDetails) throw detailedError(res.exceptionDetails);
    return res?.result?.value;
  }

  /** Evaluate inside an isolated world (CDP-minimal: shares DOM, invisible to page JS). */
  async evaluateInWorld(sessionId: string, worldName: string, expression: string, awaitPromise = false, timeoutMs = 25_000): Promise<unknown> {
    try {
      return await this.evalInWorld(sessionId, worldName, expression, awaitPromise, timeoutMs);
    } catch (e) {
      // Same-frame navigation destroys execution contexts while the frame id persists,
      // so a cached world can be dead: evict and recreate once.
      if (/cannot find context|no frame|context.*destroy|inspected target navigated|no execution context/i.test(String(e))) {
        for (const k of [...this.worlds.keys()]) {
          if (k.startsWith(`${sessionId}:${worldName}:`)) this.worlds.delete(k);
        }
        return await this.evalInWorld(sessionId, worldName, expression, awaitPromise, timeoutMs);
      }
      throw e;
    }
  }

  private async evalInWorld(sessionId: string, worldName: string, expression: string, awaitPromise: boolean, timeoutMs: number): Promise<unknown> {
    const ctx = await this.isolatedContext(sessionId, worldName, timeoutMs);
    const res = (await this.call("Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, contextId: ctx }, sessionId, timeoutMs)) as
      { exceptionDetails?: { text?: string; exception?: { description?: string } }; result?: { value?: unknown } };
    if (res?.exceptionDetails) throw detailedError(res.exceptionDetails);
    return res?.result?.value;
  }

  private worlds = new Map<string, number>();

  /** Resolve an observed JS node (from window.__jevFast) to a CDP backendNodeId. */
  async resolveBackendNode(sessionId: string, world: string | null, nodeId: number): Promise<number> {
    const objectId = await this.evaluateHandle(sessionId, world,
      `window.__jevFast?.nodes.get(${nodeId}) ?? null`);
    if (!objectId) throw new Error("Observed node no longer exists");
    const desc = (await this.call("DOM.describeNode", { objectId }, sessionId)) as
      { node?: { backendNodeId?: number } };
    if (!desc?.node?.backendNodeId) throw new Error("Could not describe DOM node");
    return desc.node.backendNodeId;
  }

  /** Evaluate and return a remote object id (for DOM.* follow-ups), without returnByValue. */
  async evaluateHandle(sessionId: string, world: string | null, expression: string): Promise<string | null> {
    let params: Record<string, unknown> = { expression, returnByValue: false };
    if (world) params = { ...params, contextId: await this.isolatedContext(sessionId, world) };
    const res = (await this.call("Runtime.evaluate", params, sessionId)) as
      { exceptionDetails?: unknown; result?: { objectId?: string; subtype?: string } };
    if (res?.exceptionDetails || !res?.result || res.result.subtype === "null") return null;
    return res.result.objectId ?? null;
  }
  private async isolatedContext(sessionId: string, worldName: string, timeoutMs = 25_000): Promise<number> {
    // Key worlds by frame: navigation destroys execution contexts, so a cached
    // context from the previous document would fail every read (stale world bug).
    const frameId = await this.mainFrameId(sessionId, timeoutMs);
    const key = `${sessionId}:${worldName}:${frameId}`;
    const cached = this.worlds.get(key);
    if (cached) return cached;
    for (const k of [...this.worlds.keys()]) {
      if (k.startsWith(`${sessionId}:${worldName}:`)) this.worlds.delete(k);
    }
    const res = (await this.call("Page.createIsolatedWorld",
      { frameId, worldName, grantUniversalAccess: true }, sessionId, timeoutMs)) as
      { executionContextId: number };
    this.worlds.set(key, res.executionContextId);
    return res.executionContextId;
  }

  private async mainFrameId(sessionId: string, timeoutMs = 25_000): Promise<string> {
    const tree = (await this.call("Page.getFrameTree", {}, sessionId, timeoutMs)) as
      { frameTree: { frame: { id: string } } };
    return tree.frameTree.frame.id;
  }

  /** Inject a script into every new document of this session (runs before page scripts, all frames). */
  async addInitScript(sessionId: string, source: string): Promise<void> {
    await this.call("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  }

  async close(): Promise<void> {
    try { this.ws?.close(); } catch { /* ignore */ }
    if (this.child) { try { this.child.kill(); } catch { /* ignore */ } this.child = null; }
  }
}

function detailedError(d: { text?: string; exception?: { description?: string } }): Error {
  const detail = d.exception?.description ?? d.text ?? "unknown evaluation error";
  return new Error(`Evaluation failed: ${String(detail).slice(0, 300)}`);
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 9222));
    });
  });
}

/** Locate a Chrome/Chromium binary on win32/darwin/linux, or null. Exported for CLI/scripts. */
export function findChrome(): string | null {
  const fromEnv = process.env.ABR_CHROME_PATH ?? process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    );
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) candidates.push(join(localApp, "Google\\Chrome\\Application\\chrome.exe"));
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium", "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null; // fall back to PATH lookup ("chrome"/"google-chrome"/"chromium")
}

export function chromeHelp(): string {
  return [
    "No Chrome/Chromium binary found.",
    "Install Chrome (https://www.google.com/chrome/) or set one of:",
    "  - browser.executablePath in BrowserRuntime.connect()",
    "  - ABR_CHROME_PATH env var",
    "  - a chrome/chromium binary on PATH",
  ].join("\n");
}
