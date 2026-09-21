// Record/replay (spec §36): deterministic action log + event log + observations.
// Replay re-resolves targets by role/name (refs are ephemeral) — no model needed.
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserRuntime } from "./browser.js";
import type { EventHandler } from "./events.js";
import type { Locator } from "./element.js";

export interface RecordedAction {
  seq: number;
  t: number; // ms since recording start
  pageId: string;
  op: "navigate" | "click" | "type" | "press" | "scroll" | "select" | "hover" | "focus" | "upload" | "wait" | "extract" | "solve";
  target?: { role?: string; name?: string };
  text?: string;
  redacted?: boolean; // secret values are never recorded; replay fails clean
  key?: string;
  url?: string;
  option?: string;
  condition?: unknown;
  files?: string[];
  task?: string;
}

export class Recorder {
  private seq = 0;
  private t0 = Date.now();
  private off: (() => void) | null = null;
  constructor(private browser: BrowserRuntime, private dir: string) {}

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(join(this.dir, "observations"), { recursive: true });
    writeFileSync(join(this.dir, "session.json"), JSON.stringify({
      startedAt: new Date(this.t0).toISOString(),
      capabilities: this.browser.capabilities(),
      // Never record secrets: config may hold profile paths only; strip anyway.
      mode: this.browser.config.mode,
    }, null, 2));
    const onEvent: EventHandler = (e) => {
      appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(e)}\n`);
      if (e.event === "observation.created") this.saveObservation(String(e.pageId), String(e.observationId));
    };
    this.off = this.browser.events.onAny(onEvent);
  }

  stop(): string {
    this.off?.();
    this.off = null;
    return this.dir;
  }

  /** Called by Page methods before execution (locator form for replayability). */
  recordAction(a: Omit<RecordedAction, "seq" | "t">): void {
    this.seq += 1;
    appendFileSync(join(this.dir, "actions.jsonl"),
      `${JSON.stringify({ seq: this.seq, t: Date.now() - this.t0, ...a })}\n`);
  }

  private saveObservation(pageId: string, observationId: string): void {
    try {
      const internal = (this.browser as unknown as {
        pagesById: Map<string, { __internal(): { getStored(id: string): { observation: unknown } | undefined } }>;
      }).pagesById.get(pageId)?.__internal().getStored(observationId);
      if (internal) {
        writeFileSync(join(this.dir, "observations", `${observationId}.json`),
          JSON.stringify(internal.observation));
      }
    } catch { /* best-effort */ }
  }

  /** Locator breadcrumb for an ElementRef (role+name survive re-observation). */
  locatorFor(pageId: string, ref: { id: string; observationId: string }): { role?: string; name?: string } | undefined {
    try {
      const internal = (this.browser as unknown as {
        pagesById: Map<string, { __internal(): {
          getStored(id: string): { observation: { elements: { ref: { id: string }; role: string; name: string }[] } } | undefined;
        } }>;
      }).pagesById.get(pageId)?.__internal().getStored(ref.observationId);
      const el = internal?.observation.elements.find((e) => e.ref.id === ref.id);
      return el ? { role: el.role, name: el.name } : undefined;
    } catch { return undefined; }
  }
}

/** Replay a recording deterministically (no planner). Returns per-step results. */
export async function replay(
  browser: BrowserRuntime, dir: string,
  o: { signal?: AbortSignal; onStep?: (r: { seq: number; op: string; ok: boolean; error?: string }) => void } = {},
): Promise<{ steps: number; failed: number }> {
  const { readFileSync, readdirSync } = await import("node:fs");
  void readdirSync;
  const lines = readFileSync(join(dir, "actions.jsonl"), "utf8").split("\n").filter(Boolean);
  let failed = 0;
  const pages = new Map<string, Awaited<ReturnType<BrowserRuntime["page"]>>>();
  const pageFor = async (id: string) => {
    let p = pages.get(id);
    if (!p) { p = await browser.createPage("about:blank"); pages.set(id, p); }
    return p;
  };
  for (const line of lines) {
    o.signal?.throwIfAborted();
    const a = JSON.parse(line) as RecordedAction;
    const step = { seq: a.seq, op: a.op, ok: true, error: undefined as string | undefined };
    try {
      const page = await pageFor(a.pageId);
      const loc: Locator | undefined = a.target?.role
        ? { kind: "role", role: a.target.role, name: a.target.name }
        : undefined;
      const fresh = async () => page.observe({ profile: "agent" });
      switch (a.op) {
        case "navigate": await page.navigate(a.url!); break;
        case "click": {
          const obs = await fresh();
          const el = find(obs, a);
          if (!el) throw new Error(`replay: no match for ${a.target?.role}:${a.target?.name}`);
          const r = await page.click(el.ref);
          if (!r.ok && r.error === "STALE_OBSERVATION") { await fresh(); }
          break;
        }
        case "type": {
          if ((a as { redacted?: boolean }).redacted) throw new Error("replay: secret value was redacted at record time");
          const obs = await fresh();
          const el = find(obs, a);
          if (!el) throw new Error(`replay: no match for ${a.target?.role}:${a.target?.name}`);
          await page.type(el.ref, a.text ?? "");
          break;
        }
        case "press": await page.press(a.key ?? "Enter"); break;
        case "scroll": await page.scroll({ deltaY: 560 }); break;
        case "select": {
          const obs = await fresh();
          const el = find(obs, a);
          if (!el || !a.option) throw new Error("replay: select target/option missing");
          await page.select(el.ref, a.option);
          break;
        }
        case "hover": case "focus": {
          const obs = await fresh();
          const el = find(obs, a);
          if (!el) throw new Error("replay: no match");
          if (a.op === "hover") await page.hover(el.ref); else await page.focus(el.ref);
          break;
        }
        case "upload": {
          if (!a.files?.every((f) => existsSync(f))) throw new Error("replay: upload files missing, skipped");
          const obs = await fresh();
          const el = find(obs, a);
          if (!el) throw new Error("replay: no match");
          await page.upload(el.ref, a.files);
          break;
        }
        case "wait":
          await page.wait((a.condition ?? { kind: "timeout", ms: 1000 }) as Parameters<typeof page.wait>[0], { timeoutMs: 15000 });
          break;
        case "extract": await page.extract(); break;
        case "solve":
          // solve() needs a planner; replay the deterministic core only.
          throw new Error("replay: solve() is agentic and cannot replay deterministically");
        default: throw new Error(`replay: unknown op ${a.op}`);
      }
      void loc;
    } catch (e) {
      step.ok = false;
      step.error = (e as Error).message;
      failed += 1;
    }
    o.onStep?.(step);
  }
  return { steps: lines.length, failed };
}

function find(
  obs: { elements: { ref: { id: string; observationId: string; pageId: string }; role: string; name: string }[] },
  a: RecordedAction,
): { ref: { id: string; observationId: string; pageId: string } } | undefined {
  if (!a.target?.role) return undefined;
  return obs.elements.find((e) =>
    e.role === a.target!.role &&
    (!a.target!.name || e.name.includes(a.target!.name) || a.target!.name.includes(e.name)));
}
