import { describe, it, expect } from "vitest";
import { RpcServer } from "../../src/rpc/server.js";
import { RpcClient } from "../../src/rpc/client.js";

async function raw(port: number, body: unknown): Promise<{ jsonrpc: string; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return (await res.json()) as never;
}

describe("rpc protocol (no browser needed)", () => {
  it("rejects parse errors, invalid requests, unknown methods, bad params", async () => {
    const s = new RpcServer({ mode: "managed" });
    const port = await s.start(0);
    try {
      expect((await raw(port, "{not json")).error?.code).toBe(-32700);
      expect((await raw(port, { jsonrpc: "1.0", id: 1, method: "page.create" })).error?.code).toBe(-32600);
      expect((await raw(port, { jsonrpc: "2.0", id: 2, method: "nope.nope", params: {} })).error?.code).toBe(-32601);
      // page.* without a reachable browser → connection error surfaced as -32603, never a crash
      const r = await raw(port, { jsonrpc: "2.0", id: 3, method: "page.click", params: { pageId: "x", target: "bogus!!" } });
      expect([-32602, -32603]).toContain(r.error?.code);
      // RpcClient round trip: with Chrome installed this lazily connects and
      // returns []; without Chrome it rejects with RpcError. Either is correct.
      const c = new RpcClient(`http://127.0.0.1:${port}`);
      const pages = await c.pages().catch((e) => e);
      expect(Array.isArray(pages) || (pages as Error).name === "RpcError").toBe(true);
    } finally { await s.stop(); }
  });
});
