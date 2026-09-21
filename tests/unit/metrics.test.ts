import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/events.js";
import { Metrics } from "../../src/metrics.js";

describe("metrics", () => {
  it("aggregates actions, stale, planner, tokens, solves, latencies", () => {
    const bus = new EventBus();
    const m = new Metrics(bus);
    bus.emit("action.started", {});
    bus.emit("action.started", {});
    bus.emit("action.completed", { action: "click", durationMs: 100 });
    bus.emit("action.failed", { action: "click", error: "STALE_OBSERVATION", durationMs: 5 });
    bus.emit("planner.started", {});
    bus.emit("planner.completed", { choice: "e1" });
    bus.emit("observation.created", { observationId: "o1", elements: 3, tokenEstimate: 40 });
    bus.emit("task.completed", { status: "completed" });
    bus.emit("task.failed", { status: "blocked" });
    const s = m.summary();
    expect(s.actionsTotal).toBe(2);
    expect(s.actionsOk).toBe(1);
    expect(s.actionsFailed).toBe(1);
    expect(s.staleCount).toBe(1);
    expect(s.plannerCalls).toBe(1);
    expect(s.plannerDecisions).toBe(1);
    expect(s.observations).toBe(1);
    expect(s.observationTokens).toBe(40);
    expect(s.solves.completed).toBe(1);
    expect(s.solves.blocked).toBe(1);
    expect(s.p95ActionLatencyMs).toBeGreaterThanOrEqual(s.p50ActionLatencyMs);
    expect(s.meanActionLatencyMs).toBeGreaterThan(0);
  });
});
