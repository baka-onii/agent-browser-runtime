// Run metrics (spec §38): reliability, performance, context efficiency.
// Fed by the event bus; summary() is cheap and allocation-free to read.
import type { EventBus } from "./events.js";

export interface MetricsSummary {
  actionsTotal: number;
  actionsOk: number;
  actionsFailed: number;
  staleCount: number;
  plannerCalls: number;
  plannerDecisions: number;
  observations: number;
  observationTokens: number;
  solves: { completed: number; failed: number; blocked: number; other: number };
  meanActionLatencyMs: number;
  p50ActionLatencyMs: number;
  p95ActionLatencyMs: number;
}

export class Metrics {
  private latencies: number[] = [];
  private s = {
    actionsTotal: 0, actionsOk: 0, actionsFailed: 0, staleCount: 0,
    plannerCalls: 0, plannerDecisions: 0, observations: 0, observationTokens: 0,
    completed: 0, failed: 0, blocked: 0, other: 0,
  };
  constructor(events: EventBus) {
    events.onAny((e) => {
      switch (e.event) {
        case "action.started": this.s.actionsTotal += 1; break;
        case "action.completed":
          this.s.actionsOk += 1;
          if (typeof e.durationMs === "number") {
            this.latencies.push(e.durationMs);
            if (this.latencies.length > 2000) this.latencies.splice(0, 500);
          }
          break;
        case "action.failed":
          this.s.actionsFailed += 1;
          if (e.error === "STALE_OBSERVATION") this.s.staleCount += 1;
          break;
        case "planner.started": this.s.plannerCalls += 1; break;
        case "planner.completed": this.s.plannerDecisions += 1; break;
        case "observation.created":
          this.s.observations += 1;
          if (typeof e.tokenEstimate === "number") this.s.observationTokens += e.tokenEstimate;
          break;
        case "task.completed": this.s.completed += 1; break;
        case "task.failed":
          if (e.status === "blocked") this.s.blocked += 1;
          else if (typeof e.status === "string" && e.status !== "completed") this.s.other += 1;
          else this.s.failed += 1;
          break;
      }
    });
  }

  summary(): MetricsSummary {
    const lat = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) => (lat.length === 0 ? 0 : lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!);
    const mean = lat.length === 0 ? 0 : Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
    return {
      actionsTotal: this.s.actionsTotal,
      actionsOk: this.s.actionsOk,
      actionsFailed: this.s.actionsFailed,
      staleCount: this.s.staleCount,
      plannerCalls: this.s.plannerCalls,
      plannerDecisions: this.s.plannerDecisions,
      observations: this.s.observations,
      observationTokens: this.s.observationTokens,
      solves: { completed: this.s.completed, failed: this.s.failed, blocked: this.s.blocked, other: this.s.other },
      meanActionLatencyMs: mean,
      p50ActionLatencyMs: q(0.5),
      p95ActionLatencyMs: q(0.95),
    };
  }
}
