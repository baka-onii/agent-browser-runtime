// Typed JSON-RPC client for the loopback server. Mirrors the Page API with plain-JSON
// types so non-Node harnesses (e.g. Python) can follow the same method/params contract.
import type { ElementRef, Locator, ObservedElement } from "../element.js";
import type { PageObservation } from "../observation.js";
import type { ActionResult, NavigationResult, WaitCondition, WaitResult } from "../page.js";
import type { SolveResult } from "../solve.js";
import type { BrowserCapabilities } from "../browser.js";
import type { RpcVerifyDescriptor } from "./server.js";

export type RpcTarget = ElementRef | Locator;
export type { RpcVerifyDescriptor };

interface RpcEnvelope { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; }

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class RpcClient {
  private id = 0;
  constructor(private baseUrl: string) {}

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.id += 1;
    const res = await fetch(`${this.baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await res.json()) as RpcEnvelope;
    if (data.error) throw new RpcError(data.error.code, data.error.message, data.error.data);
    return data.result as T;
  }

  capabilities(): Promise<BrowserCapabilities> { return this.call("browser.capabilities"); }
  health(): Promise<{ ok: boolean; latencyMs: number }> { return this.call("browser.health"); }
  metrics(): Promise<import("../metrics.js").MetricsSummary> { return this.call("browser.metrics"); }
  status(): Promise<{ ok: boolean; uptimeMs: number; browserConnected: boolean; pages: number }> {
    return this.call("server.status");
  }
  shutdown(): Promise<{ ok: boolean; shuttingDown: boolean }> { return this.call("server.shutdown"); }
  pages(): Promise<{ id: string; url: string; title: string }[]> { return this.call("browser.pages"); }
  closePage(pageId: string): Promise<{ ok: boolean }> { return this.call("browser.closePage", { pageId }); }
  createPage(url?: string): Promise<{ id: string; url: string; title: string }> {
    return this.call("page.create", url ? { url } : {});
  }
  navigate(pageId: string, url: string, timeoutMs?: number): Promise<NavigationResult> {
    return this.call("page.navigate", { pageId, url, ...(timeoutMs ? { timeoutMs } : {}) });
  }
  back(pageId: string): Promise<{ ok: boolean }> { return this.call("page.back", { pageId }); }
  forward(pageId: string): Promise<{ ok: boolean }> { return this.call("page.forward", { pageId }); }
  reload(pageId: string): Promise<{ ok: boolean }> { return this.call("page.reload", { pageId }); }
  observe(pageId: string, profile?: PageObservation["profile"], maxTokens?: number): Promise<PageObservation> {
    return this.call("page.observe", { pageId, ...(profile ? { profile } : {}), ...(maxTokens ? { maxTokens } : {}) });
  }
  click(pageId: string, target: RpcTarget): Promise<ActionResult> { return this.call("page.click", { pageId, target }); }
  type(pageId: string, target: RpcTarget, text: string): Promise<ActionResult> {
    return this.call("page.type", { pageId, target, text });
  }
  press(pageId: string, key: string): Promise<ActionResult> { return this.call("page.press", { pageId, key }); }
  scroll(pageId: string, o: { x?: number; y?: number; deltaX?: number; deltaY?: number } = {}): Promise<ActionResult> {
    return this.call("page.scroll", { pageId, ...o });
  }
  select(pageId: string, target: RpcTarget, option: string): Promise<ActionResult> {
    return this.call("page.select", { pageId, target, option });
  }
  hover(pageId: string, target: RpcTarget): Promise<ActionResult> { return this.call("page.hover", { pageId, target }); }
  focus(pageId: string, target: RpcTarget): Promise<ActionResult> { return this.call("page.focus", { pageId, target }); }
  upload(pageId: string, target: RpcTarget, files: string[]): Promise<ActionResult> {
    return this.call("page.upload", { pageId, target, files });
  }
  cookies(pageId: string): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    return this.call("page.cookies", { pageId });
  }
  setCookies(pageId: string, cookies: { name: string; value: string; domain: string; path?: string }[]): Promise<{ ok: boolean }> {
    return this.call("page.setCookies", { pageId, cookies });
  }
  clearCookies(pageId: string): Promise<{ ok: boolean }> { return this.call("page.clearCookies", { pageId }); }
  extract(pageId: string, target?: RpcTarget, maxChars?: number): Promise<{ text: string }> {
    return this.call("page.extract", { pageId, ...(target ? { target } : {}), ...(maxChars ? { maxChars } : {}) });
  }
  screenshot(pageId: string): Promise<{ dataBase64: string; format: string }> {
    return this.call("page.screenshot", { pageId });
  }
  evaluate<T>(pageId: string, expression: string): Promise<T> {
    return this.call("page.evaluate", { pageId, expression });
  }
  wait(pageId: string, condition: WaitCondition, timeoutMs?: number): Promise<WaitResult> {
    return this.call("page.wait", { pageId, condition, ...(timeoutMs ? { timeoutMs } : {}) });
  }
  frames(pageId: string): Promise<{ frameId: string; url: string }[]> {
    return this.call("page.frames", { pageId });
  }
  solve(pageId: string, task: string, o: { maxSteps?: number; maxElapsedMs?: number; verify?: RpcVerifyDescriptor } = {}): Promise<SolveResult> {
    return this.call("page.solve", { pageId, task, ...o });
  }
}

export type { ObservedElement };
export type { PageObservation, ActionResult };
