// State: semantic fingerprint (record/replay) SEPARATE from execution freshness proof.
// Constraint 2: fingerprint = sha256(url+text+action-semantics+scroll).
// Freshness = pageKey equality + guard equality + live node checks (in engine.ts).
import { createHash } from "node:crypto";

export function fingerprintSemantic(input: {
  url: string; text: string;
  actions: { id?: string; node?: unknown; kind: string; role?: string; label: string; value?: unknown }[];
  scroll: unknown;
}): string {
  const semantics = input.actions.map(({ id: _id, ...rest }) => {
    const { node: _n, ...r } = rest as Record<string, unknown>;
    void _id; void _n;
    return r;
  });
  const content = { url: input.url, text: input.text, actions: semantics, scroll: input.scroll };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

export type PageState =
  | "CONNECTED" | "READY" | "NAVIGATING" | "LOADING" | "INTERACTING"
  | "WAITING" | "PLANNING" | "STALE" | "FAILED" | "CLOSED";
