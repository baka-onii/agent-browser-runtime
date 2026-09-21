// BrowserRuntime: session/tabs/pages (spec §§6,20,21,24,25).
import { CdpTransport, type RawTransport, type CdpEvent } from "./transport.js";
import { EVASION_JS } from "./stealth/evasions.js";
import { Page } from "./page.js";
import { EventBus, type BrowserEvent, type EventHandler, type Unsubscribe } from "./events.js";
import { createLogger, fileSink, teeSink, type Logger } from "./logger.js";
import { Metrics, type MetricsSummary } from "./metrics.js";
import { Recorder } from "./recording.js";
import type { BrowserConfig, ConnectOptions } from "./config.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface BrowserCapabilities { attach: boolean; managed: boolean; cdp: boolean; planner: boolean; stealth: boolean; frames: "discover-only"; shadow: "unsupported"; }

export class BrowserRuntime {
  private transport!: CdpTransport;
  private pagesById = new Map<string, Page>();
  private pagesBySession = new Map<string, Page>();
  private pagesByTarget = new Map<string, Page>();
  /** Every target id we own or deliberately ignore (pre-existing tabs, our own creations). */
  private knownTargets = new Set<string>();
  /** Becomes true once startup discovery settles; adoption only happens after. */
  private discoveryReady = false;
  /** Serializes target acquisition: Chrome can emit targetCreated BEFORE the
   * createTarget response, so adoption must never interleave create+attach+register. */
  private targetLock: Promise<void> = Promise.resolve();

  private async withTargetLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.targetLock;
    let release!: () => void;
    this.targetLock = new Promise((r) => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }
  private downloads = new Map<string, { url: string; filename: string }>();
  private counter = 0;
  readonly events = new EventBus();
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly sessionId: string;
  readonly config: BrowserConfig;
  /** Effective download directory (auto-allowed unless allowDownloads === false). */
  readonly downloadDir: string;
  private recorder: Recorder | null = null;

  private constructor(config: BrowserConfig) {
    this.config = config;
    this.sessionId = `sess_${randomUUID().slice(0, 8)}`;
    this.logger = config.logFile
      ? createLogger(this.sessionId, teeSink(console.log, fileSink(config.logFile)))
      : createLogger(this.sessionId);
    this.metrics = new Metrics(this.events);
    this.downloadDir = config.downloadsPath ?? join(tmpdir(), "abr-downloads");
  }

  static async connect(options: ConnectOptions = { mode: "managed" }): Promise<BrowserRuntime> {
    const rt = new BrowserRuntime(options);
    rt.transport = await CdpTransport.connect(options);
    rt.transport.onEvent((e) => { void rt.routeEvent(e).catch(() => {}); });
    await rt.transport.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    // Startup discovery settles asynchronously: initial targets (starter tab, NTP,
    // extensions) emit targetCreated AFTER getTargets may have snapshotted. Quiesce,
    // then snapshot twice and ignore everything pre-existing — adoption starts after.
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 2; i++) {
      try {
        const existing = (await rt.transport.send("Target.getTargets", {})) as
          { targetInfos?: { targetId?: string }[] };
        for (const t of existing.targetInfos ?? []) { if (t.targetId) rt.knownTargets.add(t.targetId); }
      } catch { /* non-fatal */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    rt.discoveryReady = true;
    // Downloads: headless Chrome blocks them unless explicitly allowed.
    if (options.allowDownloads === false) {
      await rt.transport.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    } else {
      try { mkdirSync(rt.downloadDir, { recursive: true }); } catch { /* ignore */ }
      await rt.transport.send("Browser.setDownloadBehavior",
        { behavior: "allow", downloadPath: rt.downloadDir, eventsEnabled: true }).catch(() => {});
    }
    rt.events.emit("browser.connected", { sessionId: rt.sessionId });
    rt.logger.info({ event: "browser.connected", sessionId: rt.sessionId, mode: options.mode });
    return rt;
  }

  /** Route raw CDP events: popup adoption, target lifecycle, downloads, dialogs. */
  private async routeEvent(e: CdpEvent): Promise<void> {
    const p = e.params ?? {};
    switch (e.method) {
      case "Target.targetCreated": {
        const info = p.targetInfo as { targetId?: string; openerId?: string; type?: string; url?: string } | undefined;
        if (process.env.ABR_DEBUG_TARGETS) {
          this.logger.info({ event: "target.created.raw", targetId: info?.targetId, openerId: info?.openerId, type: info?.type, url: info?.url, known: info?.targetId ? this.knownTargets.has(info.targetId) : false });
        }
        if (!info?.targetId) break;
        // Before discovery settles, everything is pre-existing: record, never adopt.
        if (!this.discoveryReady) { this.knownTargets.add(info.targetId); break; }
        // Adopt only genuinely new page targets: our own creations and pre-existing tabs
        // are in knownTargets (creation events can arrive while we await attach).
        // chrome:// / devtools:// targets are never adopted.
        if (info?.type === "page" && !this.knownTargets.has(info.targetId)) {
          if (info.url && /^(chrome|devtools)[^:]*:\/\//.test(info.url)) {
            this.knownTargets.add(info.targetId);
          } else {
            this.knownTargets.add(info.targetId);
            await this.adoptTarget(info.targetId).catch(() => {});
          }
        }
        break;
      }
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const targetId = p.targetId as string | undefined;
        const page = targetId ? this.pagesByTarget.get(targetId) : undefined;
        if (page) {
          this.pagesById.delete(page.id);
          this.pagesByTarget.delete(targetId!);
          this.pagesBySession.delete(page.cdpSession);
          this.events.emit("page.closed", { sessionId: this.sessionId, pageId: page.id, reason: e.method });
        }
        break;
      }
      case "Browser.downloadWillBegin": {
        const guid = p.guid as string | undefined;
        if (guid) {
          this.downloads.set(guid, {
            url: String(p.url ?? ""),
            filename: String(p.suggestedFilename ?? guid),
          });
        }
        break;
      }
      case "Browser.downloadProgress": {
        if (p.state === "completed" || p.state === "canceled") {
          const guid = p.guid as string | undefined;
          const meta = guid ? this.downloads.get(guid) : undefined;
          if (guid) this.downloads.delete(guid);
          this.events.emit("download.completed", {
            sessionId: this.sessionId, guid,
            url: meta?.url ?? "", filename: meta?.filename ?? "",
            path: meta ? join(this.downloadDir, meta.filename) : "",
            state: p.state, receivedBytes: p.receivedBytes ?? 0,
          });
        }
        break;
      }
      case "Page.javascriptDialogOpening": {
        const page = e.sessionId ? this.pagesBySession.get(e.sessionId) : undefined;
        const policy = this.config.dialogs ?? "dismiss";
        this.events.emit("dialog.opened", {
          sessionId: this.sessionId, pageId: page?.id,
          type: p.type, message: p.message, url: p.url,
        });
        this.logger.info({ event: "dialog.opened", pageId: page?.id, type: p.type });
        if ((policy === "dismiss" || policy === "accept") && e.sessionId) {
          await this.transport.sendSession(e.sessionId, "Page.handleJavaScriptDialog",
            { accept: policy === "accept" }).catch(() => {});
          this.events.emit("dialog.handled", { sessionId: this.sessionId, pageId: page?.id, policy });
        }
        // "manual": leave open; harness handles via transportRaw().
        break;
      }
    }
  }

  async disconnect(): Promise<void> {
    for (const p of this.pagesById.values()) { try { await p.closeTarget(); } catch { /* ignore */ } }
    this.pagesById.clear();
    this.pagesBySession.clear();
    this.pagesByTarget.clear();
    await this.transport.close();
    this.events.emit("browser.disconnected", { sessionId: this.sessionId });
  }

  on<T extends BrowserEvent>(event: T, cb: EventHandler): Unsubscribe { return this.events.on(event, cb); }
  capabilities(): BrowserCapabilities {
    return { attach: true, managed: true, cdp: true, planner: true, stealth: true, frames: "discover-only", shadow: "unsupported" };
  }
  transportRaw(): RawTransport { return this.transport; }

  /** Liveness probe: {ok, latencyMs}. False when Chrome is gone (harness should reconnect). */
  async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.transport.send("Browser.getVersion", {});
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  metricsSummary(): MetricsSummary { return this.metrics.summary(); }

  /** Start recording deterministic actions + events + observations to dir. */
  startRecording(dir: string): void {
    this.stopRecording();
    this.recorder = new Recorder(this, dir);
    this.recorder.start();
  }

  /** Stop recording; returns the directory (or null when inactive). */
  stopRecording(): string | null {
    if (!this.recorder) return null;
    const dir = this.recorder.stop();
    this.recorder = null;
    return dir;
  }

  private pageHooks() {
    return { recorder: () => this.recorder };
  }

  async createPage(url = "about:blank"): Promise<Page> {
    const page = await this.withTargetLock(async () => {
      const res = (await this.transport.send("Target.createTarget", { url: "about:blank", background: true })) as { targetId: string };
      // Claim the id BEFORE any further await: its targetCreated event can arrive any time.
      this.knownTargets.add(res.targetId);
      const attach = (await this.transport.send("Target.attachToTarget", { targetId: res.targetId, flatten: true })) as { sessionId: string };
      this.counter += 1;
      const id = `page_${this.counter}`;
      const created = new Page(id, res.targetId, attach.sessionId, this.transport, this.events, this.logger, this.sessionId, this.config, this.pageHooks());
      this.register(created);
      return { created, cdpSession: attach.sessionId };
    });
    await this.setupSession(page.cdpSession);
    this.events.emit("page.created", { sessionId: this.sessionId, pageId: page.created.id });
    if (url !== "about:blank") await page.created.navigate(url);
    return page.created;
  }

  /** Adopt an externally-created target (popup, _blank link) into a managed Page. */
  private async adoptTarget(targetId: string): Promise<Page> {
    return this.withTargetLock(async () => {
      // Re-check under lock: the event may have raced our own createTarget response.
      const existing = this.pagesByTarget.get(targetId);
      if (existing) return existing;
      const attach = (await this.transport.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      this.counter += 1;
      const id = `page_${this.counter}`;
      const page = new Page(id, targetId, attach.sessionId, this.transport, this.events, this.logger, this.sessionId, this.config, this.pageHooks());
      this.register(page);
      // setupSession outside lock (slow CDP round trips); adopters tolerate the gap:
      // the id is registered, so duplicate adoption is impossible.
      void this.setupSession(attach.sessionId).catch(() => {});
      this.events.emit("page.created", { sessionId: this.sessionId, pageId: id, adopted: true });
      this.logger.info({ event: "page.created", pageId: id, adopted: true, targetId });
      return page;
    });
  }

  private register(page: Page): void {
    this.pagesById.set(page.id, page);
    this.pagesBySession.set(page.cdpSession, page);
    this.pagesByTarget.set(page.targetId, page);
    this.knownTargets.add(page.targetId);
  }

  /** Per-session setup: rendering, UA, locale/timezone, stealth, viewport. */
  private async setupSession(cdpSession: string): Promise<void> {
    // Keep rAF/timers rendering in owned background tabs without activating visible tab (jev-ultrafast).
    await this.transport.sendSession(cdpSession, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    // Page domain must be enabled for addScriptToEvaluateOnNewDocument.
    await this.transport.sendSession(cdpSession, "Page.enable", {}).catch(() => {});
    // Network domain must be enabled for cookies (and future network-aware waits).
    await this.transport.sendSession(cdpSession, "Network.enable", {}).catch(() => {});
    // De-brand HeadlessChrome UA (version-derived, Client Hints kept consistent).
    try {
      const ver = (await this.transport.send("Browser.getVersion", {})) as { userAgent: string };
      const ua = ver.userAgent.replace(/HeadlessChrome\//, "Chrome/");
      const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "150";
      await this.transport.sendSession(cdpSession, "Emulation.setUserAgentOverride", {
        userAgent: ua,
        ...(this.config.locale ? { acceptLanguage: this.config.locale } : {}),
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
            { brand: "Not-A.Brand", version: "99" },
          ],
          fullVersion: `${major}.0.0.0`,
          platform: "Windows", platformVersion: "15.0.0",
          architecture: "x86", model: "", mobile: false,
        },
      });
    } catch { /* non-fatal */ }
    if (this.config.timezone) {
      await this.transport.sendSession(cdpSession, "Emulation.setTimezoneOverride",
        { timezoneId: this.config.timezone }).catch(() => {});
    }
    if (this.config.locale) {
      await this.transport.sendSession(cdpSession, "Emulation.setLocaleOverride",
        { locale: this.config.locale }).catch(() => {});
    }
    if (this.config.stealth !== false) {
      // Evasion init scripts: run before page scripts in every frame (incl. iframes).
      await this.transport.sendSession(cdpSession, "Page.addScriptToEvaluateOnNewDocument", { source: EVASION_JS }).catch(() => {});
      // Init scripts only cover FUTURE documents; patch the current one directly too.
      await this.transport.sendSession(cdpSession, "Runtime.evaluate", { expression: EVASION_JS, returnByValue: true }).catch(() => {});
    }
    if (this.config.viewport) {
      await this.transport.sendSession(cdpSession, "Emulation.setDeviceMetricsOverride", {
        width: this.config.viewport.width, height: this.config.viewport.height,
        deviceScaleFactor: this.config.viewport.deviceScaleFactor ?? 1, mobile: false,
      }).catch(() => {});
    }
  }

  async closePage(id: string): Promise<void> {
    const p = this.pagesById.get(id);
    if (!p) return;
    await p.closeTarget();
    this.pagesById.delete(id);
    this.pagesByTarget.delete(p.targetId);
    this.pagesBySession.delete(p.cdpSession);
    this.events.emit("page.closed", { sessionId: this.sessionId, pageId: id });
  }

  async pages(): Promise<{ id: string; url: string; title: string }[]> {
    const out: { id: string; url: string; title: string }[] = [];
    for (const [id, p] of this.pagesById) {
      let url = "", title = "";
      try { url = await p.url(); title = await p.title(); } catch { /* ignore */ }
      out.push({ id, url, title });
    }
    return out;
  }

  async page(id?: string): Promise<Page> {
    if (id) {
      const p = this.pagesById.get(id);
      if (!p) throw new Error(`Unknown page ${id}`);
      return p;
    }
    const all = [...this.pagesById.values()];
    if (all.length === 0) return this.createPage();
    return all[0]!;
  }
}
