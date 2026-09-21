// OpenJev planner: dynamic operation/target Choice heads in ONE /v1/systemone call.
// Constraint 1: each target head ≤120 choices (provider max 128; 120 = safe margin).
// Ported from jev-ultrafast model.py (MIT).
import { PlannerError } from "../errors.js";
import type { ObservedAction } from "../element.js";
import type { Planner, PlannerInput, PlannerDecision, ActionHistoryEntry } from "./planner.js";
import { NEXT_ACTION, TARGET_RULES } from "./prompts.js";

export const MAX_TARGET_CHOICES = 120;

export interface OpenJevConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface ElementView { index: string; label: string; operations: string[]; role?: string; value?: string; options?: { index: string; label: string; value: string }[]; }

export function buildActionSpace(actions: ObservedAction[]): {
  elements: ElementView[]; targets: Record<string, Record<string, ObservedAction>>; controls: Record<string, ObservedAction>;
  omittedTargets: Record<string, number>;
} {
  const elements: ElementView[] = [];
  const indices = new Map<number, string>();
  const targets: Record<string, Record<string, ObservedAction>> = {};
  const controls: Record<string, ObservedAction> = {};
  const ops: Record<string, string> = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" };
  for (const a of actions) {
    const op = ops[a.kind];
    if (!op) { controls[a.id.toUpperCase()] = a; continue; }
    const node = a.node ?? -Math.random();
    if (!indices.has(node as number)) {
      const index = String(elements.length + 1);
      indices.set(node as number, index);
      const el: ElementView = { index, label: a.label.split(" → ")[0]!, operations: [] };
      if (a.role) el.role = a.role;
      if (a.value !== undefined) el.value = String(a.value);
      if (a.kind === "select") { el.value = a.current_value ?? ""; el.options = []; }
      elements.push(el);
    }
    const index = indices.get(node as number)!;
    const el = elements[Number(index) - 1]!;
    if (!el.operations.includes(op)) el.operations.push(op);
    const group = (targets[op] ??= {});
    if (a.kind === "select") {
      const t = `${index}:${(el.options?.length ?? 0) + 1}`;
      el.options!.push({ index: t, label: a.label, value: String(a.value ?? "") });
      group[t] = a;
    } else {
      group[index] = a;
    }
  }
  // Enforce ≤120 per head with deterministic priority (document order preserved; tail truncated)
  const omittedTargets: Record<string, number> = {};
  for (const [op, group] of Object.entries(targets)) {
    const keys = Object.keys(group);
    if (keys.length > MAX_TARGET_CHOICES) {
      omittedTargets[op] = keys.length - MAX_TARGET_CHOICES;
      for (const k of keys.slice(MAX_TARGET_CHOICES)) delete group[k];
    }
  }
  return { elements, targets, controls, omittedTargets };
}

function validateChoice(answer: { choice?: unknown; probabilities?: unknown; confidence?: unknown }, ids: string[]): void {
  const a = answer as { choice: string; probabilities: Record<string, number>; confidence: number };
  const probs = a.probabilities ?? {};
  const nums = [...Object.values(probs), a.confidence];
  const valid =
    typeof a.choice === "string" && ids.includes(a.choice) &&
    Object.keys(probs).length === ids.length && ids.every((id) => id in probs) &&
    nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
    Math.abs(Object.values(probs).reduce((s, v) => s + v, 0) - 1) < 0.02 &&
    (probs[a.choice] ?? -1) >= Math.max(...Object.values(probs)) - 1e-6;
  if (!valid) throw new PlannerError("Invalid TypeSafe response; no action executed.");
}

export class OpenJevPlanner implements Planner {
  constructor(private cfg: OpenJevConfig = {}) {}
  private get key(): string {
    const k = this.cfg.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.OPENJEV_API_KEY;
    if (!k) throw new PlannerError("Missing TYPESAFE_API_KEY for OpenJev planner");
    return k;
  }
  async plan(input: PlannerInput): Promise<PlannerDecision> {
    const actions = input.internalActions ?? [];
    const { elements, targets, controls, omittedTargets } = buildActionSpace(actions);
    void omittedTargets;
    const labels: Record<string, string> = {
      CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
      TYPE_TEXT: "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
      SELECT: "Select an observed dropdown value.",
    };
    const operations: Record<string, string> = {};
    for (const k of Object.keys(targets)) if (labels[k]) operations[k] = labels[k]!;
    for (const [k, v] of Object.entries(controls)) operations[k] = v.label;
    operations.DONE = "Every requirement is visibly satisfied.";
    operations.BLOCKED = "No supported operation can progress.";
    if (Object.keys(operations).length > 128) throw new PlannerError("Operation head exceeds provider limit");

    const questions: Record<string, unknown> = {
      operation: { type: "choice", criteria: operations, instructions: { goal: input.goal, rules: NEXT_ACTION } },
    };
    for (const [op, cands] of Object.entries(targets)) {
      const criteria: Record<string, unknown> = {};
      for (const [idx, a] of Object.entries(cands)) {
        criteria[idx] = {
          element: `[${idx}] ${a.label}`,
          current_value: a.current_value ?? a.value ?? "",
          ...(a.role ? { role: a.role } : {}),
        };
      }
      questions[`${op.toLowerCase()}_target`] = {
        type: "choice",
        criteria,
        instructions: { goal: input.goal, operation: op, rules: [NEXT_ACTION, TARGET_RULES] },
      };
    }
    const body = {
      model: this.cfg.model ?? process.env.TYPESAFE_MODEL ?? "jev-latest",
      state: {
        page: { url: input.observation.url, title: input.observation.title, text: input.observation.text },
        elements,
        recent_actions: input.history.slice(-10).map((h: ActionHistoryEntry) =>
          ({ action: h.action, kind: h.kind, text: h.text, page_changed: h.page_changed })),
      },
      questions,
    };
    const base = (this.cfg.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
    const started = Date.now();
    const res = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    }).catch(() => { throw new PlannerError("Model connection failed; no action executed."); });
    if (!res.ok) throw new PlannerError(`Model provider HTTP ${res.status}; no action executed.`);
    const data = (await res.json()) as { answers: Record<string, { choice: string; probabilities: Record<string, number>; confidence: number }>; model?: string; usage?: unknown };
    const opIds = Object.keys(operations);
    const opAns = data.answers?.operation;
    if (!opAns) throw new PlannerError("Missing operation answer");
    validateChoice(opAns, opIds);
    const op = opAns.choice;
    if (op in targets) {
      const tAns = data.answers?.[`${op.toLowerCase()}_target`];
      if (!tAns) throw new PlannerError(`Missing ${op} target answer`);
      validateChoice(tAns, Object.keys(targets[op]!));
      const tgt = tAns.choice;
      const action = targets[op]![tgt]!;
      const probs: Record<string, number> = {};
      for (const [idx, a] of Object.entries(targets[op]!)) probs[a.id] = tAns.probabilities[idx] ?? 0;
      return { choice: action.id, operation: op, target: tgt, confidence: opAns.confidence, probabilities: probs, raw: data };
    }
    const cid = op in controls ? controls[op]!.id : op;
    void started;
    return { choice: cid, operation: op, target: null, confidence: opAns.confidence, probabilities: { [cid]: opAns.probabilities[op] ?? 1 }, raw: data };
  }
}
