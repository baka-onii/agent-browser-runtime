// MCP adapter (spec §41): translates MCP tool calls into the public runtime API.
// The runtime never depends on MCP; this module is a thin boundary layer.
// Transport: newline-delimited JSON-RPC 2.0 over stdio. No external SDK.
import { BrowserRuntime } from "../browser.js";
import type { ConnectOptions } from "../config.js";
import { isElementRef } from "../action.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: ToolDef[] = [
  { name: "browser_open", description: "Open a URL in a new page. Returns {id, url, title}.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_navigate", description: "Navigate a page. Returns {ok, url}.", inputSchema: { type: "object", properties: { pageId: { type: "string" }, url: { type: "string" } }, required: ["pageId", "url"] } },
  { name: "browser_observe", description: "Compact structured observation: elements with ephemeral refs, text, scroll. Re-observe after any DOM change.", inputSchema: { type: "object", properties: { pageId: { type: "string" }, profile: { type: "string", enum: ["minimal", "agent", "text", "full"] } }, required: ["pageId"] } },
  { name: "browser_click", description: "Click an element ref or locator.", inputSchema: { type: "object", properties: { pageId: { type: "string" }, target: { type: "object" } }, required: ["pageId", "target"] } },
  { name: "browser_type", description: "Type text into an editable element ref.", inputSchema: { type: "object", properties: { pageId: { type: "string" }, target: { type: "object" }, text: { type: "string" } }, required: ["pageId", "target", "text"] } },
  { name: "browser_press", description: "Press a key (Enter, Tab, Escape, single chars).", inputSchema: { type: "object", properties: { pageId: { type: "string" }, key: { type: "string" } }, required: ["pageId", "key"] } },
  { name: "browser_scroll", description: "Scroll the page (deltaY default 560).", inputSchema: { type: "object", properties: { pageId: { type: "string" }, deltaY: { type: "number" } }, required: ["pageId"] } },
  { name: "browser_extract", description: "Extract visible text (whole page or one element).", inputSchema: { type: "object", properties: { pageId: { type: "string" }, target: { type: "object" } }, required: ["pageId"] } },
  { name: "browser_screenshot", description: "PNG screenshot, base64 dataUri.", inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] } },
  { name: "browser_wait", description: "Semantic wait: text_stable/text_present/url_matches/element_visible/document_ready/timeout.", inputSchema: { type: "object", properties: { pageId: { type: "string" }, condition: { type: "object" }, timeoutMs: { type: "number" } }, required: ["pageId", "condition"] } },
  { name: "browser_solve", description: "Agentic fallback: pursue a goal (needs TYPESAFE_API_KEY server-side or pass maxSteps with MockPlanner). Optional serializable verify {urlContains,textContains}.", inputSchema: { type: "object", properties: { pageId: { type: "string" }, task: { type: "string" }, maxSteps: { type: "number" }, verify: { type: "object" } }, required: ["pageId", "task"] } },
  { name: "browser_close", description: "Close a page.", inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] } },
];

function asTarget(v: unknown): Parameters<Awaited<ReturnType<BrowserRuntime["page"]>>["click"]>[0] {
  if (isElementRef(v)) return v;
  if (v && typeof v === "object" && "kind" in (v as object)) {
    return v as { kind: "role"; role: string; name?: string };
  }
  throw new Error("target must be an ElementRef {id, observationId, pageId} or Locator {kind, ...}");
}

export class McpServer {
  private browser: BrowserRuntime | null = null;
  constructor(private options: ConnectOptions = { mode: "managed" }) {}

  private async needBrowser(): Promise<BrowserRuntime> {
    if (!this.browser) this.browser = await BrowserRuntime.connect(this.options);
    return this.browser;
  }

  async close(): Promise<void> {
    await this.browser?.disconnect().catch(() => {});
    this.browser = null;
  }

  async handle(msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
    const id = msg.id ?? null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, data } });
    try {
      switch (msg.method) {
        case "initialize":
          return ok({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agent-browser-runtime", version: "0.1.0" },
          });
        case "notifications/initialized": return null;
        case "ping": return ok({});
        case "tools/list": return ok({ tools: TOOLS });
        case "tools/call": {
          const p = msg.params ?? {};
          const out = await this.callTool(String(p.name), (p.arguments ?? {}) as Record<string, unknown>);
          return ok({ content: [{ type: "text", text: JSON.stringify(out) }] });
        }
        default: return err(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      const be = e as { code?: string; message?: string };
      return err(-32603, be?.message ?? "Internal error", be?.code ? { errorCode: be.code } : undefined);
    }
  }

  private async callTool(name: string, a: Record<string, unknown>): Promise<unknown> {
    const str = (k: string): string => {
      if (typeof a[k] !== "string") throw new Error(`Missing string argument: ${k}`);
      return a[k] as string;
    };
    switch (name) {
      case "browser_open": {
        const b = await this.needBrowser();
        const page = await b.createPage(str("url"));
        return { id: page.id, url: await page.url().catch(() => ""), title: await page.title().catch(() => "") };
      }
      default: {
        const b = await this.needBrowser();
        const page = await b.page(str("pageId"));
        switch (name) {
          case "browser_navigate": return page.navigate(str("url"));
          case "browser_observe":
            return page.observe({ profile: (a.profile as "minimal" | "agent" | "text" | "full" | undefined) ?? "agent" });
          case "browser_click": return page.click(asTarget(a.target));
          case "browser_type": return page.type(asTarget(a.target), str("text"));
          case "browser_press": return page.press(str("key"));
          case "browser_scroll":
            return page.scroll(typeof a.deltaY === "number" ? { deltaY: a.deltaY } : {});
          case "browser_extract":
            return page.extract(a.target === undefined ? undefined : asTarget(a.target));
          case "browser_screenshot": {
            const buf = await page.screenshot();
            return { dataUri: `data:image/png;base64,${buf.toString("base64")}` };
          }
          case "browser_wait":
            return page.wait(
              a.condition as Parameters<typeof page.wait>[0],
              typeof a.timeoutMs === "number" ? { timeoutMs: a.timeoutMs } : {},
            );
          case "browser_solve": {
            const verify = a.verify as { urlContains?: string; textContains?: string } | undefined;
            return page.solve(str("task"), {
              maxSteps: typeof a.maxSteps === "number" ? a.maxSteps : undefined,
              verifier: verify ? async (_g, obs) => {
                if (verify.urlContains && !obs.url.includes(verify.urlContains)) return false;
                if (verify.textContains && !obs.text.includes(verify.textContains)) return false;
                return true;
              } : undefined,
            });
          }
          case "browser_close":
            await b.closePage(str("pageId"));
            return { ok: true };
          default: throw new Error(`Unknown tool: ${name}`);
        }
      }
    }
  }

  /** Serve NDJSON JSON-RPC over stdio (the MCP stdio transport). */
  async serveStdio(): Promise<void> {
    let buf = "";
    const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { msg = JSON.parse(line); }
        catch { out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
        try {
          const res = await this.handle(msg);
          if (res) out(res);
        } catch (e) {
          out({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } });
        }
      }
    }
  }
}
