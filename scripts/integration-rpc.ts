// Live RPC integration: loopback server + typed client + managed Chromium.
// Run: npx tsx scripts/integration-rpc.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcServer } from "../src/rpc/server.js";
import { RpcClient } from "../src/rpc/client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "browser");
const fixtures = createServer(async (req, res) => {
  try {
    const name = (req.url ?? "/").split("?")[0]!.replace(/^\//, "") || "basic.html";
    const data = await readFile(join(root, name));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    try { res.end("nf"); } catch { /* client gone */ }
  }
});
await new Promise<void>((r) => fixtures.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(fixtures.address() as { port: number }).port}`;

const server = new RpcServer({
  mode: "managed", // Chrome auto-detected
  headless: true,
});
const port = await server.start(0);
console.log(`rpc server: http://127.0.0.1:${port}/`);
const c = new RpcClient(`http://127.0.0.1:${port}`);
const rpcBase = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failures++;
};
try {
  const caps = await c.capabilities();
  check("capabilities", caps.cdp === true && caps.stealth === true);
  const st0 = await c.status();
  check("status", st0.ok === true && st0.pages === 0, JSON.stringify(st0));
  const { id } = await c.createPage(`${base}/basic.html`);
  check("create", !!id, id);
  const obs = await c.observe(id, "agent");
  check("observe", obs.elements.length >= 2, `${obs.elements.length} els`);
  const box = obs.elements.find((e) => e.role === "textbox")!;
  check("type", (await c.type(id, box.ref, "rpc-hello")).ok);
  check("value", (await c.evaluate<string>(id, "document.querySelector('input')?.value")) === "rpc-hello");
  const btn = (await c.observe(id)).elements.find((e) => e.role === "button")!;
  check("click", (await c.click(id, btn.ref)).ok);
  check("extract", (await c.extract(id)).text.includes("Basic"));
  check("frames", Array.isArray(await c.frames(id)));
  const shot = await c.screenshot(id);
  check("screenshot", shot.dataBase64.length > 1000, `${shot.dataBase64.length}b64`);
  check("wait", (await c.wait(id, { kind: "text_present", text: "Basic" }, 5000)).ok);
  const solved = await c.solve(id, "noop", { maxSteps: 2, verify: { textContains: "Basic" } });
  check("solve+verify", solved.status === "completed", solved.status);
  // Unknown observation ids throw (RpcError/STALE_OBSERVATION); known-but-mutated
  // refs return ok:false. Same split as the in-process API.
  try {
    await c.click(id, { id: "zzz", observationId: "nope", pageId: id } as never);
    check("bad ref → STALE_OBSERVATION", false);
  } catch (e) {
    const err = e as { message?: string; data?: { errorCode?: string } };
    check("bad ref → STALE_OBSERVATION", (err.data?.errorCode ?? err.message ?? "").includes("STALE"), err.message);
  }
  check("pages", (await c.pages()).some((p) => p.id === id));
  const st1 = await c.status();
  check("status connected", st1.browserConnected === true && st1.pages >= 1, JSON.stringify(st1));
  const evRes = await fetch(`${rpcBase}/events`);
  check("sse stream", evRes.status === 200 && (evRes.headers.get("content-type") ?? "").includes("text/event-stream"));
  await evRes.body?.cancel();
  check("close", (await c.closePage(id)).ok);
} catch (e) {
  failures++;
  console.error("HARNESS ERROR", e);
} finally {
  await server.stop();
  fixtures.close();
}
console.log(failures === 0 ? "RPC ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
