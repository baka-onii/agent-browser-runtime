// Agent loop (spec §44, ported from jev-ultrafast agent.py).
// Constraint 3: DONE requires caller/deterministic verifier; model verifier opt-in only.
import type { Page } from "./page.js";
import type { SolveOptions } from "./config.js";
import { DEFAULT_LIMITS } from "./config.js";
import type { ActionHistoryEntry, Planner } from "./planner/planner.js";
import { MockPlanner } from "./planner/planner.js";
import { OpenJevPlanner } from "./planner/openjev.js";
import { fieldContext, fieldText } from "./planner/textHelper.js";
import { executeObserved } from "./engine.js";
import { StaleObservationError, TimeoutError } from "./errors.js";
import type { ObservedAction } from "./element.js";

export type SolveStatus = "completed" | "failed" | "blocked" | "timeout" | "max_steps" | "cancelled";
export interface SolveResult { status: SolveStatus; steps: number; elapsedMs: number; actions: string[]; history: ActionHistoryEntry[]; }

export async function solvePage(page: Page, goal: string, options: SolveOptions = {}): Promise<SolveResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_LIMITS.maxSteps;
  const maxElapsed = options.maxElapsedMs ?? DEFAULT_LIMITS.maxElapsedMs;
  const historyLimit = options.historyLimit ?? 5;
  const started = Date.now();
  const internal = page.__internal();
  internal.events.emit("task.started", { sessionId: internal.sessionId, pageId: page.id, goal });

  let planner: Planner;
  if (options.planner) planner = options.planner;
  else if (process.env.TYPESAFE_API_KEY || process.env.OPENJEV_API_KEY) planner = new OpenJevPlanner();
  else planner = new MockPlanner([]);

  const history: ActionHistoryEntry[] = [];
  const actions: string[] = [];
  let plannerCalls = 0;
  let pendingText: { ctx: unknown; text: string; helper: { model: string; latencyMs: number } } | null = null;
  let step = 0;

  const elapsed = () => Date.now() - started;
  const checkBudget = () => {
    options.signal?.throwIfAborted();
    if (elapsed() > maxElapsed) throw new TimeoutError(`solve exceeded maxElapsedMs ${maxElapsed}`);
  };

  try {
    for (step = 0; step < maxSteps; step++) {
      checkBudget();
      const observation = await page.observe({ profile: "agent", signal: options.signal });
      const stored = internal.latestStored();
      const allActions: ObservedAction[] = (stored as unknown as { actions: ObservedAction[] } | undefined
        ? (stored as unknown as { actions: ObservedAction[] }).actions : []) ?? [];
      // Uploads are harness-driven (need local file paths); never planner-selected.
      const internalActions = allActions.filter((a) => a.kind !== "upload");

      plannerCalls += 1;
      if (plannerCalls > (options.maxPlannerCalls ?? DEFAULT_LIMITS.maxPlannerCalls)) {
        return finish("max_steps");
      }
      internal.events.emit("planner.started", { sessionId: internal.sessionId, pageId: page.id, step });
      const decision = await planner.plan({ goal, observation, history: history.slice(-historyLimit), internalActions });
      internal.events.emit("planner.completed", { sessionId: internal.sessionId, pageId: page.id, choice: decision.choice });

      if (decision.choice === "DONE") {
        const ok = await verifyDone(goal, observation, options);
        if (ok) return finish("completed");
        // Unverified DONE is not success — keep going (bounded by maxSteps)
        continue;
      }
      if (decision.choice === "BLOCKED") return finish("blocked");

      const action = internalActions.find((a) => a.id === decision.choice);
      if (!action) continue; // invalid id: re-observe next step

      let text: string | undefined;
      let helper: { model: string; latencyMs: number } | undefined;
      if (action.kind === "fill") {
        const ctx = fieldContext(goal, action, observation, history);
        if (pendingText && JSON.stringify(pendingText.ctx) === JSON.stringify(ctx)) {
          text = pendingText.text; helper = pendingText.helper;
        } else {
          const r = await fieldText(ctx);
          text = r.text; helper = { model: r.model, latencyMs: r.latencyMs };
          pendingText = { ctx, text, helper };
        }
      }
      // Execute with freshness proof (engine rechecks pageKey+guard+live node)
      const proof = (stored as unknown as { proof: { page_key: unknown; guards: Record<string, unknown>; marker: unknown } }).proof;
      try {
        await executeObserved(internal.transport, internal.cdpSession, action, proof, text,
          { world: internal.world, humanize: internal.humanize });
      } catch (e) {
        if (e instanceof StaleObservationError) {
          pendingText = pendingText && action.kind === "fill" ? pendingText : null;
          continue; // auto re-observe + re-plan
        }
        return finish("failed");
      }
      pendingText = null;
      const after = await page.observe({ profile: "agent", signal: options.signal }).catch(() => null);
      const changed = after ? after.fingerprint !== observation.fingerprint : null;
      history.push({
        step: history.length + 1, action: action.label, kind: action.kind, choice: action.id,
        text: text ?? null, page_changed: changed, url: observation.url,
        probability: decision.probabilities?.[action.id], confidence: decision.confidence, elapsed_ms: elapsed(),
      });
      actions.push(`${action.kind.toUpperCase()} ${action.id}`);
      // 3x no-change (non-wait) → blocked
      const last3 = history.slice(-3);
      if (last3.length === 3 && last3.every((h) => h.page_changed === false && h.kind !== "wait")) {
        return finish("blocked");
      }
    }
    return finish("max_steps");
  } catch (e) {
    if ((e as Error).name === "AbortError") return finish("cancelled");
    if (e instanceof TimeoutError) return finish("timeout");
    return finish("failed");
  }

  function finish(status: SolveStatus): SolveResult {
    const r: SolveResult = { status, steps: history.length, elapsedMs: elapsed(), actions, history };
    internal.events.emit(status === "completed" ? "task.completed" : "task.failed",
      { sessionId: internal.sessionId, pageId: page.id, status, steps: r.steps });
    return r;
  }
}

/** Generic DONE verification (constraint 3): caller verifier first; model verifier opt-in, never default. */
async function verifyDone(
  goal: string,
  observation: import("./observation.js").PageObservation,
  options: SolveOptions,
): Promise<boolean> {
  if (options.verifier) return !!(await options.verifier(goal, observation));
  if (options.useModelVerifier) {
    const { verifyWithModel } = await import("./verifier.js");
    return verifyWithModel(goal, observation);
  }
  return false;
}
