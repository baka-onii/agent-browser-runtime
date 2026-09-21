// Planner interfaces (spec §§42,43). OpenJev is one implementation; Mock/Rule for tests.
import type { PageObservation } from "../observation.js";

export interface ActionHistoryEntry {
  step: number; action: string; kind: string; choice: string;
  text?: string | null; page_changed: boolean | null; url: string;
  probability?: number; confidence?: number; latency_ms?: number; elapsed_ms?: number;
}

export interface PlannerDecision {
  choice: string; // observed action id ("e7") | "scroll_down" | "wait" | "DONE" | "BLOCKED"
  operation: string;
  target: string | null;
  confidence?: number;
  probabilities?: Record<string, number>;
  raw?: unknown;
}

export interface PlannerInput {
  goal: string;
  observation: PageObservation;
  history: ActionHistoryEntry[];
  internalActions?: import("../element.js").ObservedAction[];
}

export interface Planner { plan(input: PlannerInput): Promise<PlannerDecision>; }

export interface DecisionProvider {
  decide(state: unknown, questions: unknown): Promise<unknown>;
}

/** Deterministic scripted planner for tests / replay (no model). */
export class MockPlanner implements Planner {
  private queue: string[];
  constructor(choices: string[]) { this.queue = [...choices]; }
  async plan(_input: PlannerInput): Promise<PlannerDecision> {
    const choice = this.queue.shift() ?? "DONE";
    return { choice, operation: choice === "DONE" ? "DONE" : choice === "BLOCKED" ? "BLOCKED" : "CLICK", target: null, confidence: 1 };
  }
}

/** Rule planner: clicks first button matching goal text, else DONE. */
export class RulePlanner implements Planner {
  async plan(input: PlannerInput): Promise<PlannerDecision> {
    const goal = input.goal.toLowerCase();
    const words = goal.split(/\W+/).filter((w) => w.length > 3);
    for (const el of input.observation.elements) {
      if (words.some((w) => el.name.toLowerCase().includes(w))) {
        return { choice: el.ref.id, operation: "CLICK", target: el.ref.id, confidence: 0.5 };
      }
    }
    const first = input.observation.elements[0];
    if (first) return { choice: first.ref.id, operation: "CLICK", target: first.ref.id, confidence: 0.3 };
    return { choice: "DONE", operation: "DONE", target: null, confidence: 0.2 };
  }
}
