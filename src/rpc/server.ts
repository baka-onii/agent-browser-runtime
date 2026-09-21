// Local JSON-RPC 2.0 server (spec §40). Loopback only — the integration boundary for
// Python / other-language harnesses and external automation systems.
// Owns one BrowserRuntime; pages addressed by id. Functions can't cross RPC, so
// solve() accepts a serializable verifier descriptor instead of a callback.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BrowserRuntime } from "../browser.js";
import type { ConnectOptions } from "../config.js";
import { isElementRef } from "../action.js";
import type { ElementRef, Locator } from "../element.js";

export interface RpcVerifyDescriptor { urlContains?: string; textContains?: string; }

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }
interface RpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown }; }

type Target = ElementRef | Locator;

function asTarget(v: unknown): Target {
  if (isElementRef(v)) return v;
  if (v && typeof v === "object" && "kind" in (v as object)) return v as Locator;
  throw rpcError(-32602, "target must be an ElementRef {id, observationId, pageId} or Locator {kind, ...}");
}

function rpcError(code: number, message: string, data?: unknown): Error & { rpcCode?: number; rpcData?: unknown } {
  const e = new Error(message) as Error & { rpcCode?: number; rpcData?: unknown };
  e.rpcCode = code; e.rpcData = data;
  return e;
}

function browserErrorData(e: unknown): { code: number; message: string; data?: unknown } {
  if (e && typeof e === "object" && "rpcCode" in (e as object)) {
    const r = e as { rpcCode: number; message: string; rpcData?: unknown };
    return { code: r.rpcCode, message: r.message, data: r.rpcData };
  }
  const err = e as { code?: string; message?: string };
  return { code: -32603, message: err?.message ?? "Internal error", data: err?.code ? { errorCode: err.code } : undefined };
}

const KNOWN_METHODS = new Set([
  "browser.capabilities", "browser.pages", "browser.closePage", "browser.health", "browser.metrics",
  "server.status", "server.shutdown",
  "page.create", "page.navigate", "page.back", "page.forward", "page.reload",
  "page.observe", "page.click", "page.type", "page.press", "page.scroll",
  "page.select", "page.hover", "page.focus", "page.upload",
  "page.extract", "page.screenshot",
  "page.cookies", "page.setCookies", "page.clearCookies",
  "page.evaluate", "page.wait", "page.frames", "page.solve",
]);

export class RpcServer {
  private http: Server | null = null;
  private browser: BrowserRuntime | null = null;
  private ownedConfig: ConnectOptions;
  private startedAt = Date.now();
  private sseClients = new Set<ServerResponse>();

  constructor(connectOptions: ConnectOptions = { mode: "managed" }) {
    this.ownedConfig = connectOptions;
  }

  async start(port = 0): Promise<number> {
    // Listen first; the browser connects lazily on first browser.*/page.* call,
    // so the server (and protocol surface) is testable without Chrome running.
    this.http = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.http!.listen(port, "127.0.0.1", resolve));
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.http?.close(() => resolve()) ?? resolve());
    this.http = null;
    for (const res of [...this.sseClients]) { try { res.end(); } catch { /* ignore */ } }
    this.sseClients.clear();
    await this.browser?.disconnect().catch(() => {});
    this.browser = null;
    this.closedResolve();
  }

  private closedResolve: () => void = () => {};
  private closedPromise: Promise<void> | null = null;
  /** Resolves when stop() completes (lets `abr serve` exit after server.shutdown). */
  closed(): Promise<void> {
    if (!this.closedPromise) {
      this.closedPromise = new Promise<void>((r) => { this.closedResolve = r; });
    }
    return this.closedPromise;
  }

  private async needBrowser(): Promise<BrowserRuntime> {
    if (!this.browser) {
      this.browser = await BrowserRuntime.connect(this.ownedConfig);
      // Fan runtime events out to SSE subscribers.
      this.browser.events.onAny((e) => {
        const line = `data: ${JSON.stringify(e)}\n\n`;
        for (const res of [...this.sseClients]) {
          try { res.write(line); } catch { this.sseClients.delete(res); }
        }
      });
    }
    return this.browser;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // SSE event stream: GET /events → text/event-stream of every runtime event.
    if (req.method === "GET" && (req.url ?? "").split("?")[0] === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      this.sseClients.add(res);
      req.on("close", () => { this.sseClients.delete(res); });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST only" } }));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 32 * 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      void (async () => {
        let body: RpcRequest;
        try { body = JSON.parse(raw) as RpcRequest; }
        catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }
        const out = await this.dispatch(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      })();
    });
  }

  private async dispatch(body: RpcRequest): Promise<RpcResponse> {
    const id = body.id ?? null;
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    }
    try {
      const result = await this.call(body.method, (body.params ?? {}) as Record<string, unknown>);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      const err = browserErrorData(e);
      return { jsonrpc: "2.0", id, error: err };
    }
  }

  private str(p: Record<string, unknown>, k: string, required = true): string {
    const v = p[k];
    if (typeof v !== "string") {
      if (!required) return "";
      throw rpcError(-32602, `Missing/invalid string param: ${k}`);
    }
    return v;
  }

  private async call(method: string, p: Record<string, unknown>): Promise<unknown> {
    // Fast fail on typos without launching a browser.
    if (!KNOWN_METHODS.has(method)) throw rpcError(-32601, `Method not found: ${method}`);
    if (method === "server.status") {
      let pages: { id: string; url: string; title: string }[] = [];
      let health: { ok: boolean; latencyMs: number } = { ok: false, latencyMs: 0 };
      try { if (this.browser) { pages = await this.browser.pages(); health = await this.browser.health(); } }
      catch { /* degraded: report what we know */ }
      return { ok: true, uptimeMs: Date.now() - this.startedAt, browserConnected: !!this.browser, health, pages: pages.length };
    }
    if (method === "server.shutdown") {
      // Respond first, then tear down (dispatch writes the response before this fires).
      // No process.exit here: lifetime belongs to the host (`abr serve` exits via closed()).
      setTimeout(() => { void this.stop(); }, 100);
      return { ok: true, shuttingDown: true };
    }
    if (method === "browser.health") {
      return this.browser ? this.browser.health() : { ok: false, latencyMs: 0 };
    }
    if (method === "browser.metrics") {
      return this.browser ? this.browser.metricsSummary() : { error: "browser not connected" };
    }
    const browser = await this.needBrowser();
    switch (method) {
      case "browser.capabilities": return browser.capabilities();
      case "browser.pages": return browser.pages();
      case "browser.closePage": await browser.closePage(this.str(p, "pageId")); return { ok: true };
      case "page.create": {
        const page = await browser.createPage(typeof p.url === "string" ? p.url : "about:blank");
        return { id: page.id, url: await page.url().catch(() => ""), title: await page.title().catch(() => "") };
      }
      case "page.navigate": {
        const page = await browser.page(this.str(p, "pageId"));
        return page.navigate(this.str(p, "url"), typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {});
      }
      case "page.back": await (await browser.page(this.str(p, "pageId"))).back(); return { ok: true };
      case "page.forward": await (await browser.page(this.str(p, "pageId"))).forward(); return { ok: true };
      case "page.reload": await (await browser.page(this.str(p, "pageId"))).reload(); return { ok: true };
      case "page.observe": {
        const page = await browser.page(this.str(p, "pageId"));
        return page.observe({
          profile: (p.profile as "minimal" | "agent" | "text" | "full" | undefined) ?? "agent",
          maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
        });
      }
      case "page.click": return (await browser.page(this.str(p, "pageId"))).click(asTarget(p.target));
      case "page.type": return (await browser.page(this.str(p, "pageId"))).type(asTarget(p.target), this.str(p, "text"));
      case "page.press": return (await browser.page(this.str(p, "pageId"))).press(this.str(p, "key"));
      case "page.scroll": {
        const page = await browser.page(this.str(p, "pageId"));
        return page.scroll({
          x: num(p.x), y: num(p.y), deltaX: num(p.deltaX), deltaY: num(p.deltaY),
        });
      }
      case "page.select": return (await browser.page(this.str(p, "pageId"))).select(asTarget(p.target), this.str(p, "option", false) || (p.option as string | { value?: string; label?: string }));
      case "page.hover": return (await browser.page(this.str(p, "pageId"))).hover(asTarget(p.target));
      case "page.focus": return (await browser.page(this.str(p, "pageId"))).focus(asTarget(p.target));
      case "page.upload": {
        if (!Array.isArray(p.files) || p.files.length === 0 || !p.files.every((f) => typeof f === "string")) {
          throw rpcError(-32602, "files must be a non-empty string array");
        }
        return (await browser.page(this.str(p, "pageId"))).upload(asTarget(p.target), p.files as string[]);
      }
      case "page.cookies": return (await browser.page(this.str(p, "pageId"))).cookies();
      case "page.setCookies": {
        if (!Array.isArray(p.cookies)) throw rpcError(-32602, "cookies must be an array");
        await (await browser.page(this.str(p, "pageId"))).setCookies(
          p.cookies as { name: string; value: string; domain: string }[]);
        return { ok: true };
      }
      case "page.clearCookies":
        await (await browser.page(this.str(p, "pageId"))).clearCookies();
        return { ok: true };
      case "page.extract": {
        const page = await browser.page(this.str(p, "pageId"));
        return page.extract(
          p.target === undefined ? undefined : asTarget(p.target),
          typeof p.maxChars === "number" ? { maxChars: p.maxChars } : {},
        );
      }
      case "page.screenshot": {
        const buf = await (await browser.page(this.str(p, "pageId"))).screenshot();
        return { dataBase64: buf.toString("base64"), format: "png" };
      }
      case "page.evaluate": return (await browser.page(this.str(p, "pageId"))).evaluate<unknown>(this.str(p, "expression"));
      case "page.wait": {
        const cond = p.condition as { kind: string } | undefined;
        if (!cond || typeof cond.kind !== "string") throw rpcError(-32602, "Missing condition {kind, ...}");
        return (await browser.page(this.str(p, "pageId"))).wait(
          cond as Parameters<Awaited<ReturnType<BrowserRuntime["page"]>>["wait"]>[0],
          typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {},
        );
      }
      case "page.frames": return (await browser.page(this.str(p, "pageId"))).frames();
      case "page.solve": {
        const page = await browser.page(this.str(p, "pageId"));
        const verify = p.verify as RpcVerifyDescriptor | undefined;
        return page.solve(this.str(p, "task"), {
          maxSteps: typeof p.maxSteps === "number" ? p.maxSteps : undefined,
          maxElapsedMs: typeof p.maxElapsedMs === "number" ? p.maxElapsedMs : undefined,
          verifier: verify
            ? async (_goal, obs) => {
              if (verify.urlContains && !obs.url.includes(verify.urlContains)) return false;
              if (verify.textContains && !obs.text.includes(verify.textContains)) return false;
              return true;
            }
            : undefined,
        });
      }
      default: throw rpcError(-32601, `Method not found: ${method}`); // unreachable (KNOWN_METHODS checked above)
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
