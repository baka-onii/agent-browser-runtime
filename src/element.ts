// Element refs (public, ephemeral) vs observed actions (internal). Spec §8 + constraint 5.
// Public surface: ElementRef only. Internal ObservedAction keeps DOM node identity,
// geometry, guards — never exported from index.ts.
export interface ElementRef { id: string; observationId: string; pageId: string; }

export type Locator =
  | { kind: "role"; role: string; name?: string }
  | { kind: "text"; text: string }
  | { kind: "css"; selector: string }
  | { kind: "xpath"; expression: string };

export interface ObservedElement {
  ref: ElementRef;
  role: string;
  name: string;
  value?: string;
  enabled?: boolean;
  checked?: string;
  selected?: string;
  expanded?: string;
}

/** Rich internal record — NOT part of public API. */
export interface ObservedAction {
  id: string; // e.g. "e7", "scroll_down", "wait"
  node: number | null;
  kind: "click" | "fill" | "select" | "scroll" | "wait" | "upload";
  role?: string;
  label: string;
  value?: string;
  current_value?: string;
  rect?: { x: number; y: number; w: number; h: number };
  delta?: number;
  checked?: string;
  selected?: string;
  expanded?: string;
}
