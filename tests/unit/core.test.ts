import { describe, it, expect } from "vitest";
import { fingerprintSemantic } from "../../src/state.js";
import { buildActionSpace, MAX_TARGET_CHOICES } from "../../src/planner/openjev.js";
import { estimateTokens, applyProfile } from "../../src/observation.js";
import { MockPlanner } from "../../src/planner/planner.js";
import type { ObservedAction } from "../../src/element.js";

describe("fingerprint", () => {
  it("is stable for identical input and differs on text change", () => {
    const base = { url: "https://x.test", text: "hi", actions: [{ kind: "click", label: "Send" }], scroll: { y: 0 } };
    expect(fingerprintSemantic(base)).toBe(fingerprintSemantic(base));
    expect(fingerprintSemantic({ ...base, text: "bye" })).not.toBe(fingerprintSemantic(base));
  });
  it("ignores node identity (semantic, not freshness)", () => {
    const a = { url: "u", text: "t", actions: [{ kind: "click", label: "B", node: 1 }], scroll: {} };
    const b = { url: "u", text: "t", actions: [{ kind: "click", label: "B", node: 99 }], scroll: {} };
    expect(fingerprintSemantic(a as never)).toBe(fingerprintSemantic(b as never));
  });
});

describe("action space cap", () => {
  it("truncates each head to ≤120", () => {
    const actions: ObservedAction[] = Array.from({ length: 300 }, (_, i) => ({
      id: `e${i + 1}`, node: 1000 + i, kind: "click", role: "button", label: `Btn ${i}`,
    }));
    const { targets, omittedTargets } = buildActionSpace(actions);
    expect(Object.keys(targets.CLICK!).length).toBeLessThanOrEqual(MAX_TARGET_CHOICES);
    expect(omittedTargets.CLICK).toBeGreaterThan(0);
  });
});

describe("observation", () => {
  it("estimates tokens and trims by maxTokens", () => {
    const els = Array.from({ length: 50 }, (_, i) => ({
      ref: { id: `e${i}`, observationId: "o", pageId: "p" }, role: "button", name: `Button number ${i} with long label`,
    }));
    expect(estimateTokens("hello", els)).toBeGreaterThan(10);
    const { elements } = applyProfile(els, "x".repeat(20000), "agent", 200);
    expect(estimateTokens("x".repeat(500), elements)).toBeLessThanOrEqual(2000);
  });
  it("mock planner returns scripted choices then DONE", async () => {
    const m = new MockPlanner(["e1"]);
    const d1 = await m.plan({ goal: "g", observation: {} as never, history: [] });
    const d2 = await m.plan({ goal: "g", observation: {} as never, history: [] });
    expect(d1.choice).toBe("e1");
    expect(d2.choice).toBe("DONE");
  });
});
