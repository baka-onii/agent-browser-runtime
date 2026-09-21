// Typed actions (spec §12). Planner output is validated against this; raw JS/coords rejected.
import type { ElementRef as Ref, Locator } from "./element.js";
import type { SelectOption } from "./config.js";

export type BrowserAction =
  | { kind: "click"; target: Ref | Locator }
  | { kind: "type"; target: Ref | Locator; text: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x?: number; y?: number; deltaX?: number; deltaY?: number }
  | { kind: "select"; target: Ref | Locator; option: SelectOption }
  | { kind: "hover"; target: Ref | Locator }
  | { kind: "focus"; target: Ref | Locator }
  | { kind: "navigate"; url: string }
  | { kind: "wait"; ms?: number }
  | { kind: "extract"; target?: Ref | Locator }
  | { kind: "screenshot" }
  | { kind: "done" }
  | { kind: "blocked" };

export type ActionChoiceId = string; // "e7" | "scroll_down" | "wait" | "DONE" | "BLOCKED"

export function isElementRef(t: unknown): t is Ref {
  return !!t && typeof t === "object" && "id" in (t as object) && "observationId" in (t as object);
}

/** Reject anything the planner must never emit: selectors-as-strings, coords, JS. */
export function assertPlannerActionSafe(a: { kind: string; target?: unknown }): void {
  if (typeof a.target === "string") {
    // Bare string targets are only legal as validated observation ids (e1..); anything else rejected.
    if (!/^(e\d+|scroll_(up|down)|wait|DONE|BLOCKED)$/.test(a.target)) {
      throw new Error(`Unsafe planner target rejected: ${JSON.stringify(a.target)}`);
    }
  }
  if ((a as Record<string, unknown>).expression ?? (a as Record<string, unknown>).selector) {
    // selectors must arrive as typed Locator objects, never raw strings from the model
    if (typeof a.target === "string") throw new Error("Raw selector/js from planner rejected");
  }
}
