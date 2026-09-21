// Observation types + profiles (spec §§10,11,31). Password values redacted before planner.
import type { ObservedAction, ObservedElement } from "./element.js";

export type ObservationProfile = "minimal" | "agent" | "text" | "full";

export interface PageObservation {
  observationId: string;
  pageId: string;
  url: string;
  title: string;
  readyState?: string;
  fingerprint: string;
  elements: ObservedElement[];
  text: string;
  scroll: { x: number; y: number; maxY: number };
  tokenEstimate: number;
  stats: { elements: number; interactiveElements: number; visibleTextChars: number; estimatedTokens: number; omittedActions?: number; omittedTargets?: Record<string, number> };
  profile: ObservationProfile;
}

export interface RawSnapshot {
  url: string; title: string; w: number; h: number; text: string;
  scroll: { y: number; height: number };
  actions: ObservedAction[];
  marker: unknown; page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
}

let obsCounter = 0;
export function nextObservationId(): string {
  obsCounter += 1;
  return `obs_${Date.now().toString(36)}_${obsCounter}`;
}

/** Rough token estimate: ~4 chars/token over text + element labels. */
export function estimateTokens(text: string, elements: { role: string; name: string; value?: string }[]): number {
  let chars = text.length;
  for (const e of elements) chars += e.role.length + e.name.length + (e.value ?? "").length + 10;
  return Math.ceil(chars / 4);
}

export function applyProfile(
  elements: ObservedElement[],
  text: string,
  profile: ObservationProfile,
  maxTokens?: number,
): { elements: ObservedElement[]; text: string } {
  let els = elements;
  let t = text;
  if (profile === "minimal") { t = ""; }
  else if (profile === "agent") {
    // Compact: drop empty-named generic elements beyond 120 handled by planner cap; trim text
    t = t.slice(0, 6000);
  } else if (profile === "text") { els = []; }
  // full: everything
  if (maxTokens !== undefined) {
    // Greedy trim: shrink text first, then drop tail elements (document order = lowest priority last)
    while (els.length > 0 && estimateTokens(t, els) > maxTokens) {
      if (t.length > 500) t = t.slice(0, Math.max(500, t.length - 1000));
      else els = els.slice(0, -1);
    }
    // Never remove elements silently without stats — caller records omitted count
  }
  return { elements: els, text: t };
}

/** Redact sensitive values before sending to model. */
export function redactForModel(elements: ObservedElement[]): ObservedElement[] {
  return elements.map((e) => {
    if (e.role === "textbox" && /pass|secret|token|card/i.test(e.name)) {
      return { ...e, value: "[REDACTED]" };
    }
    return e;
  });
}
