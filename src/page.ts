// Page API (spec §7). Deterministic ops independent of AI.
import type { CdpTransport } from "./transport.js";
import type { EventBus } from "./events.js";
import type { Logger } from "./logger.js";
import type { BrowserConfig, NavigateOptions, ObserveOptions, ScreenshotOptions, ScrollOptions, SelectOption, ExtractOptions, WaitOptions, SolveOptions } from "./config.js";
import { assertOriginAllowed } from "./config.js";
import type { ElementRef, Locator, ObservedAction, ObservedElement } from "./element.js";
import { isElementRef } from "./action.js";
import type { PageObservation, RawSnapshot } from "./observation.js";
import { nextObservationId, estimateTokens, applyProfile } from "./observation.js";
import { SNAPSHOT_JS } from "./snapshot.js";
import { fingerprintSemantic } from "./state.js";
import { checkFresh, executeObserved, type FreshnessProof } from "./engine.js";
import {
  NavigationError, ObservationError, StaleObservationError, ElementNotFoundError,
  ElementNotInteractableError, TimeoutError, CapabilityError, PermissionError,
} from "./errors.js";
import { solvePage, type SolveResult } from "./solve.js";

export interface ActionResult { ok: boolean; observationId: string; error?: string; durationMs: number; }
export interface NavigationResult { ok: boolean; url: string; }
export type WaitCondition =
  | { kind: "element_visible"; locator: Locator }
  | { kind: "element_hidden"; locator: Locator }
  | { kind: "text_present"; text: string }
  | { kind: "text_changed"; from: string }
  | { kind: "text_stable"; stableForMs?: number; target?: ElementRef | Locator }
  | { kind: "url_matches"; pattern: string }
  | { kind: "network_idle"; idleMs?: number }
  | { kind: "document_ready" }
  | { kind: "timeout"; ms: number };

export interface WaitResult { ok: boolean; elapsedMs: number; }

interface StoredObservation {
  observation: PageObservation;
  actions: ObservedAction[];
  proof: FreshnessProof;
}

export class Page {
  readonly id: string;
  readonly targetId: string;
  readonly cdpSession: string;
  private store = new Map<string, StoredObservation>();

  constructor(
    id: string, targetId: string, cdpSession: string,
    private transport: CdpTransport,
    private events: EventBus, private logger: Logger,
    private sessionId: string, private config: BrowserConfig,
    private hooks?: { recorder(): import("./recording.js").Recorder | null },
  ) {
    this.id = id; this.targetId = targetId; this.cdpSession = cdpSession;
  }

  /** Breadcrumb for the recorder (role+name survive re-observation; refs don't). */
  private crumb(target: ElementRef | Locator): { role?: string; name?: string } | undefined {
    if (!isElementRef(target)) {
      if (target.kind === "role") return { role: target.role, name: target.name };
      if (target.kind === "text") return { name: target.text };
      return undefined;
    }
    return this.hooks?.recorder()?.locatorFor(this.id, target);
  }

  private note(op: "navigate" | "click" | "type" | "press" | "scroll" | "select" | "hover" | "focus" | "upload" | "wait" | "solve", extra: Record<string, unknown> = {}): void {
    try { this.hooks?.recorder()?.recordAction({ pageId: this.id, op, ...extra }); } catch { /* recording is best-effort */ }
  }

  /** Internal DOM reads: isolated world when stealth is on (invisible to page JS). */
  private read(expression: string, awaitPromise = false, timeoutMs = 25_000): Promise<unknown> {
    if (this.config.stealth === false) return this.transport.evaluate(this.cdpSession, expression, awaitPromise, timeoutMs);
    return this.transport.evaluateInWorld(this.cdpSession, "abr", expression, awaitPromise, timeoutMs);
  }

  /** Isolated-world name for engine calls, or null when stealth is off. */
  world(): string | null { return this.config.stealth === false ? null : "abr"; }

  async url(): Promise<string> {
    const v = await this.read("location.href");
    return String(v ?? "");
  }
  async title(): Promise<string> {
    const v = await this.read("document.title");
    return String(v ?? "");
  }

  async navigate(url: string, options: NavigateOptions = {}): Promise<NavigationResult> {
    if (this.config.allowNavigation === false) throw new PermissionError("Navigation disabled by policy");
    assertOriginAllowed(url, this.config.allowedOrigins);
    this.note("navigate", { url });
    this.events.emit("page.navigated", { sessionId: this.sessionId, pageId: this.id, url });
    await this.transport.sendSession(this.cdpSession, "Page.navigate", { url });
    const timeout = options.timeoutMs ?? 15_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      options.signal?.throwIfAborted();
      // Short per-read budget: on a busy renderer each poll fails fast
      // instead of multiplying the 25s CDP default into minutes.
      const state = await this.read("document.readyState", false, 4000).catch(() => "loading");
      if (state === "complete") break;
      await sleep(50);
    }
    return { ok: true, url };
  }
  async back(): Promise<void> { await this.transport.sendSession(this.cdpSession, "Runtime.evaluate", { expression: "history.back()", returnByValue: true }); }
  async forward(): Promise<void> { await this.transport.sendSession(this.cdpSession, "Runtime.evaluate", { expression: "history.forward()", returnByValue: true }); }
  async reload(): Promise<void> { await this.transport.sendSession(this.cdpSession, "Page.reload", {}); }

  async observe(options: ObserveOptions = {}): Promise<PageObservation> {
    options.signal?.throwIfAborted();
    const profile = options.profile ?? "agent";
    // Let in-flight navigations settle (bounded) before snapshotting.
    const settleStart = Date.now();
    while (Date.now() - settleStart < 5000) {
      options.signal?.throwIfAborted();
      try {
        const state = await this.read("document.readyState", false, 4000);
        if (state === "complete") break;
      } catch { /* no document yet */ }
      await sleep(150);
    }
    let raw: RawSnapshot | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        raw = (await this.read(SNAPSHOT_JS, false, 10_000)) as RawSnapshot | null;
        if (raw) break;
      } catch { /* navigating mid-read */ }
      await sleep(20);
    }
    if (!raw) throw new ObservationError("Document is navigating; observation unavailable");
    const observationId = nextObservationId();
    const fingerprint = fingerprintSemantic(raw);
    const elements: ObservedElement[] = [];
    const actions: ObservedAction[] = [];
    const seenNodes = new Set<number>();
    for (const a of raw.actions) {
      actions.push(a);
      if (a.kind === "click" || a.kind === "fill" || a.kind === "upload") {
        // One public element per DOM node (fill variant wins: snapshot emits fill before Open-click).
        if (typeof a.node === "number") {
          if (seenNodes.has(a.node)) continue;
          seenNodes.add(a.node);
        } else if (elements.some((e) => e.ref.id === a.id)) continue;
        const label = a.label.replace(/^Open /, "");
        elements.push({
          ref: { id: a.id, observationId, pageId: this.id },
          role: a.role ?? "button",
          name: label,
          value: typeof a.value === "string" ? a.value.slice(0, 500) : undefined,
          enabled: true,
          checked: a.checked, selected: a.selected, expanded: a.expanded,
        });
      }
    }
    const shaped = applyProfile(elements, raw.text, profile, options.maxTokens);
    const tokenEstimate = estimateTokens(shaped.text, shaped.elements);
    const obs: PageObservation = {
      observationId, pageId: this.id, url: raw.url, title: raw.title,
      fingerprint, elements: shaped.elements, text: shaped.text,
      scroll: { x: 0, y: raw.scroll.y, maxY: raw.scroll.height },
      tokenEstimate,
      stats: {
        elements: shaped.elements.length, interactiveElements: shaped.elements.length,
        visibleTextChars: shaped.text.length, estimatedTokens: tokenEstimate,
        omittedActions: raw.omitted_actions,
      },
      profile,
    };
    this.store.set(observationId, { observation: obs, actions, proof: { page_key: raw.page_key, guards: raw.guards, marker: raw.marker } });
    if (this.store.size > 5) { const k = this.store.keys().next().value as string; this.store.delete(k); }
    this.events.emit("observation.created", { sessionId: this.sessionId, pageId: this.id, observationId, elements: obs.elements.length, tokenEstimate });
    this.logger.info({ event: "observation.created", pageId: this.id, observationId, elements: obs.elements.length });
    return obs;
  }

  private resolve(target: ElementRef | Locator): { action: ObservedAction; proof: FreshnessProof; observationId: string } {
    if (!isElementRef(target)) return this.resolveLocator(target);
    const stored = this.store.get(target.observationId);
    if (!stored) throw new StaleObservationError(target.observationId);
    const action = stored.actions.find((a) => a.id === target.id);
    if (!action) throw new ElementNotFoundError(`Element ${target.id} not in observation ${target.observationId}`);
    return { action, proof: stored.proof, observationId: target.observationId };
  }

  private resolveLocator(loc: Locator): { action: ObservedAction; proof: FreshnessProof; observationId: string } {
    // Deterministic locator resolution against the freshest stored observation
    const latest = [...this.store.values()].at(-1);
    if (!latest) throw new ElementNotFoundError("Observe before acting");
    const els = latest.observation.elements;
    let found: ObservedElement | undefined;
    if (loc.kind === "role") found = els.find((e) => e.role === loc.role && (!loc.name || e.name.includes(loc.name)));
    else if (loc.kind === "text") found = els.find((e) => e.name.includes(loc.text));
    else if (loc.kind === "css" || loc.kind === "xpath") {
      throw new CapabilityError("css/xpath locators require explicit opt-in; prefer role/text");
    }
    if (!found) throw new ElementNotFoundError(`Locator found nothing: ${JSON.stringify(loc)}`);
    const action = latest.actions.find((a) => a.id === found!.ref.id)!;
    return { action, proof: latest.proof, observationId: latest.observation.observationId };
  }

  private async runAction(label: string, fn: () => Promise<string>): Promise<ActionResult> {
    const start = Date.now();
    const obsId = [...this.store.keys()].at(-1) ?? "obs_none";
    this.events.emit("action.started", { sessionId: this.sessionId, pageId: this.id, action: label });
    try {
      const executed = await fn();
      const ms = Date.now() - start;
      this.events.emit("action.completed", { sessionId: this.sessionId, pageId: this.id, action: label, target: executed, durationMs: ms });
      return { ok: true, observationId: obsId, durationMs: ms };
    } catch (e) {
      const ms = Date.now() - start;
      const code = e instanceof StaleObservationError ? "STALE_OBSERVATION" : (e as Error).message;
      this.events.emit("action.failed", { sessionId: this.sessionId, pageId: this.id, action: label, error: code, durationMs: ms });
      if (e instanceof StaleObservationError) return { ok: false, observationId: e.observationId, error: "STALE_OBSERVATION", durationMs: ms };
      throw e;
    }
  }

  async click(target: ElementRef | Locator): Promise<ActionResult> {
    this.note("click", { target: this.crumb(target) });
    const { action, proof } = this.resolve(target);
    if (action.kind === "upload") {
      throw new ElementNotInteractableError("File inputs open an OS dialog on click; use page.upload() instead");
    }
    if (action.kind === "fill") {
      // Click on editable = focus/open variant: find sibling click action on same node
      const stored = [...this.store.values()].at(-1)!;
      const open = stored.actions.find((a) => a.node === action.node && a.kind === "click") ?? action;
      return this.runAction("click", async () => (await executeObserved(this.transport, this.cdpSession, open, proof, undefined, this.engineOpts())).executed);
    }
    return this.runAction("click", async () => (await executeObserved(this.transport, this.cdpSession, action, proof, undefined, this.engineOpts())).executed);
  }

  async type(target: ElementRef | Locator, text: string): Promise<ActionResult> {    const { action, proof } = this.resolve(target);
    const crumb = this.crumb(target);
    // Never record secret values (passwords, tokens, cards) — replay will prompt/fail clean.
    const sensitive = crumb?.name ? /pass|secret|token|card|cvv|ssn/i.test(crumb.name) : false;
    this.note("type", { target: crumb, ...(sensitive ? { redacted: true } : { text: text.slice(0, 500) }) });
    const fill = action.kind === "fill" ? action : (() => {
      const stored = [...this.store.values()].at(-1)!;
      const f = stored.actions.find((a) => a.node === action.node && a.kind === "fill");
      if (!f) throw new ElementNotInteractableError("Target is not editable");
      return f;
    })();
    return this.runAction("type", async () => (await executeObserved(this.transport, this.cdpSession, fill, proof, text, this.engineOpts())).executed);
  }

  /** Set files on an <input type=file>. Never clicks (OS dialog); filenames stay local. */
  async upload(target: ElementRef | Locator, files: string[]): Promise<ActionResult> {
    if (this.config.allowUploads === false) throw new PermissionError("Uploads disabled by policy");
    if (!files || files.length === 0) throw new ElementNotFoundError("upload() needs at least one file path");
    this.note("upload", { target: this.crumb(target), files });
    const { action, proof } = this.resolve(target);
    const up = action.kind === "upload" ? action : (() => {
      const stored = [...this.store.values()].at(-1)!;
      const f = stored.actions.find((a) => a.node === action.node && a.kind === "upload");
      if (!f) throw new ElementNotInteractableError("Target is not a file input");
      return f;
    })();
    return this.runAction("upload", async () => (await executeObserved(
      this.transport, this.cdpSession, up, proof, undefined, { ...this.engineOpts(), files })).executed);
  }
  async press(key: string): Promise<ActionResult> {
    const humanize = this.config.humanize !== false;
    this.note("press", { key });
    return this.runAction("press", async () => {
      if (humanize) await sleep(30 + Math.random() * 90);
      // Map common keys; fallback to insertText for single chars
      if (key.length === 1) await this.transport.sendSession(this.cdpSession, "Input.insertText", { text: key });
      else {
        const codeMap: Record<string, string> = { Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown" };
        const code = codeMap[key] ?? key;
        await this.transport.sendSession(this.cdpSession, "Input.dispatchKeyEvent", { type: "keyDown", key: code, code });
        if (humanize) await sleep(40 + Math.random() * 80);
        await this.transport.sendSession(this.cdpSession, "Input.dispatchKeyEvent", { type: "keyUp", key: code, code });
      }
      return key;
    });
  }

  async scroll(o: ScrollOptions = {}): Promise<ActionResult> {
    const humanize = this.config.humanize !== false;
    this.note("scroll", {});
    return this.runAction("scroll", async () => {
      const steps = humanize ? 2 + Math.floor(Math.random() * 3) : 1;
      for (let i = 0; i < steps; i++) {
        await this.transport.sendSession(this.cdpSession, "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: o.x ?? 550, y: o.y ?? 650, deltaX: o.deltaX ?? 0, deltaY: Math.round((o.deltaY ?? 560) / steps) });
        if (humanize && i < steps - 1) await sleep(80 + Math.random() * 160);
      }
      return "scroll";
    });
  }

  async select(target: ElementRef | Locator, option: SelectOption): Promise<ActionResult> {
    this.note("select", { target: this.crumb(target), option: typeof option === "string" ? option : (option.value ?? option.label ?? "") });
    const { action, proof } = this.resolve(target);
    if (action.kind !== "select") {
      // Resolve select variant among sibling actions with same label prefix
      const stored = [...this.store.values()].at(-1)!;
      const base = action.label.replace(/ → .*$/, "").replace(/^Open /, "");
      const candidates = stored.actions.filter((a) => a.kind === "select" && a.label.startsWith(base));
      const want = typeof option === "string" ? option : (option.value ?? option.label ?? "");
      const match = candidates.find((c) => c.value === want || c.label.endsWith(String(want)));
      if (!match) throw new ElementNotFoundError(`Option not observed: ${JSON.stringify(option)}`);
      return this.runAction("select", async () => (await executeObserved(this.transport, this.cdpSession, match, proof, undefined, this.engineOpts())).executed);
    }
    return this.runAction("select", async () => (await executeObserved(this.transport, this.cdpSession, action, proof, undefined, this.engineOpts())).executed);
  }

  async hover(target: ElementRef | Locator): Promise<ActionResult> {
    this.note("hover", { target: this.crumb(target) });
    const { action } = this.resolve(target);
    if (!action.rect) throw new ElementNotInteractableError("No geometry for hover");
    return this.runAction("hover", async () => {
      const x = action.rect!.x + action.rect!.w / 2, y = action.rect!.y + action.rect!.h / 2;
      await this.transport.sendSession(this.cdpSession, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return action.id;
    });
  }

  async focus(target: ElementRef | Locator): Promise<ActionResult> {
    this.note("focus", { target: this.crumb(target) });
    const { action, proof } = this.resolve(target);
    if (!(await checkFresh(this.transport, this.cdpSession, action, proof, this.world()))) {
      return { ok: false, observationId: target && isElementRef(target) ? target.observationId : "obs_current", error: "STALE_OBSERVATION", durationMs: 0 };
    }
    await this.read(`(()=>{window.__jevFast?.nodes.get(${action.node})?.focus()})()`);
    return { ok: true, observationId: "obs_current", durationMs: 0 };
  }

  async extract(target?: ElementRef | Locator, options: ExtractOptions = {}): Promise<{ text: string }> {
    options.signal?.throwIfAborted();
    if (!target) {
      const obs = await this.observe({ profile: "text" });
      return { text: obs.text.slice(0, options.maxChars ?? 20000) };
    }
    const { action } = this.resolve(target);
    const v = await this.read(
      `(()=>{const e=window.__jevFast?.nodes.get(${action.node}); return e?.innerText ?? e?.value ?? ''})()`);
    return { text: String(v ?? "").slice(0, options.maxChars ?? 20000) };
  }

  async screenshot(o: ScreenshotOptions = {}): Promise<Buffer> {
    if (!o.fullPage) {
      const res = (await this.transport.sendSession(this.cdpSession, "Page.captureScreenshot", { format: "png" })) as { data: string };
      return Buffer.from(res.data, "base64");
    }
    const metrics = (await this.transport.sendSession(this.cdpSession, "Page.getLayoutMetrics", {})) as
      { cssContentSize?: { width: number; height: number } };
    const w = Math.max(1, Math.ceil(metrics.cssContentSize?.width ?? 1280));
    const h = Math.max(1, Math.ceil(metrics.cssContentSize?.height ?? 800));
    const res = (await this.transport.sendSession(this.cdpSession, "Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
    })) as { data: string };
    return Buffer.from(res.data, "base64");
  }

  /** Harness-level cookie access (never exposed to models; see §28). */
  async cookies(): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    const res = (await this.transport.sendSession(this.cdpSession, "Network.getCookies", {})) as
      { cookies: { name: string; value: string; domain: string; path: string }[] };
    return res.cookies ?? [];
  }

  async setCookies(cookies: { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean }[]): Promise<void> {
    for (const c of cookies) {
      await this.transport.sendSession(this.cdpSession, "Network.setCookie", {
        name: c.name, value: c.value, domain: c.domain,
        path: c.path ?? "/", secure: c.secure ?? false, httpOnly: c.httpOnly ?? false,
      });
    }
  }

  async clearCookies(): Promise<void> {
    await this.transport.sendSession(this.cdpSession, "Network.clearBrowserCookies", {});
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return (await this.transport.evaluate(this.cdpSession, expression)) as T;
  }

  async frames(): Promise<{ frameId: string; url: string }[]> {
    const tree = (await this.transport.sendSession(this.cdpSession, "Page.getFrameTree", {})) as {
      frameTree: { frame: { id: string; url: string }; childFrames?: { frame: { id: string; url: string } }[] };
    };
    const out = [{ frameId: tree.frameTree.frame.id, url: tree.frameTree.frame.url }];
    const walk = (n: { frame: { id: string; url: string }; childFrames?: typeof tree.frameTree.childFrames }) => {
      for (const c of n.childFrames ?? []) { out.push({ frameId: c.frame.id, url: c.frame.url }); }
    };
    walk(tree.frameTree);
    return out;
  }

  async wait(cond: WaitCondition, options: WaitOptions = {}): Promise<WaitResult> {
    const timeout = options.timeoutMs ?? 10_000;
    const start = Date.now();
    this.note("wait", { condition: cond });
    this.events.emit("wait.started", { sessionId: this.sessionId, pageId: this.id, condition: cond.kind });
    try {
      if (cond.kind === "timeout") { await sleep(Math.min(cond.ms, timeout)); }
      else if (cond.kind === "document_ready") { await this.waitFor(() => `document.readyState==="complete"`, timeout, options); }
      else if (cond.kind === "url_matches") { await this.waitFor(() => `location.href.includes(${JSON.stringify(cond.pattern)})`, timeout, options); }
      else if (cond.kind === "text_present") { await this.waitFor(() => `document.body?.innerText?.includes(${JSON.stringify(cond.text)})`, timeout, options); }
      else if (cond.kind === "text_changed") { await this.waitFor(() => `!document.body?.innerText?.includes(${JSON.stringify(cond.from)})`, timeout, options); }
      else if (cond.kind === "text_stable") {
        const stableFor = cond.stableForMs ?? 500;
        let last = "", stableSince = Date.now();
        while (Date.now() - start < timeout) {
          options.signal?.throwIfAborted();
          const cur = String((await this.read("document.body?.innerText?.slice(0,6000)")) ?? "");
          if (cur === last) { if (Date.now() - stableSince >= stableFor) break; }
          else { last = cur; stableSince = Date.now(); }
          await sleep(100);
        }
        if (Date.now() - start >= timeout && Date.now() - stableSince < stableFor) throw new TimeoutError("text did not stabilize");
      } else if (cond.kind === "element_visible" || cond.kind === "element_hidden") {
        const want = cond.kind === "element_visible";
        while (Date.now() - start < timeout) {
          options.signal?.throwIfAborted();
          const obs = await this.observe({ profile: "minimal" });
          let found = false;
          const l = cond.locator;
          if (l.kind === "role") found = obs.elements.some((e) => e.role === l.role && (!l.name || e.name.includes(l.name)));
          else if (l.kind === "text") found = obs.elements.some((e) => e.name.includes(l.text));
          if (found === want) break;
          await sleep(150);
        }
        if (Date.now() - start >= timeout) throw new TimeoutError(`${cond.kind} timed out`);
      } else if (cond.kind === "network_idle") {
        await this.transport.sendSession(this.cdpSession, "Page.navigate", {}).catch(() => {});
        await sleep(Math.min(cond.idleMs ?? 500, timeout));
      }
      const elapsed = Date.now() - start;
      this.events.emit("wait.completed", { sessionId: this.sessionId, pageId: this.id, elapsedMs: elapsed });
      return { ok: true, elapsedMs: elapsed };
    } catch (e) {
      if (e instanceof TimeoutError) throw e;
      throw new TimeoutError((e as Error).message);
    }
  }

  private async waitFor(jsPred: () => string, timeout: number, options: WaitOptions): Promise<void> {
    const start = Date.now();
    const expr = `(()=>{try{return (${jsPred()})}catch{return false}})()`;
    while (Date.now() - start < timeout) {
      options.signal?.throwIfAborted();
      const v = await this.read(expr).catch(() => false);
      if (v === true) return;
      await sleep(100);
    }
    throw new TimeoutError("wait timed out");
  }

  async solve(task: string, options: SolveOptions = {}): Promise<SolveResult> {
    this.note("solve", { task: task.slice(0, 300) });
    return solvePage(this, task, options);
  }

  async closeTarget(): Promise<void> {
    try { await this.transport.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* ignore */ }
  }

  /** Internal: engine access for solve loop. */
  __internal() {
    return {
      transport: this.transport, cdpSession: this.cdpSession,
      events: this.events, logger: this.logger, sessionId: this.sessionId,
      world: this.world(), humanize: this.config.humanize !== false,
      getStored: (id: string) => this.store.get(id),
      latestStored: () => [...this.store.values()].at(-1),
    };
  }

  private engineOpts(): { world: string | null; humanize: boolean } {
    return { world: this.world(), humanize: this.config.humanize !== false };
  }
}

export async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
export { NavigationError as _NavErr, ObservationError as _ObsErr };
void NavigationError; void ObservationError;
