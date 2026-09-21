// Live integration harness: local fixtures + managed Chromium (headless).
// Run: npx tsx scripts/integration.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserRuntime } from "../src/index.js";
import { MockPlanner } from "../src/planner/planner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "browser");
const server = createServer(async (req, res) => {
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
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
console.log(`fixture server: ${base}`);

const browser = await BrowserRuntime.connect({
  mode: "managed", // Chrome auto-detected (ABR_CHROME_PATH / browser.executablePath override)
  headless: true,
  viewport: { width: 1120, height: 780 },
});
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failures++;
};

try {
  // 1. Programmatic: observe/type/click/screenshot
  const p1 = await browser.createPage(`${base}/basic.html`);
  const obs = await p1.observe();
  check("observe elements", obs.elements.length >= 2, JSON.stringify(obs.elements.map((e) => e.role + ":" + e.name)));
  const input = obs.elements.find((e) => e.role === "textbox");
  check("find textbox", !!input);
  if (input) {
    const r = await p1.type(input.ref, "hello");
    check("type ok", r.ok);
    const v = await p1.evaluate<string>("document.querySelector('input')?.value");
    check("input value", v === "hello", `got=${v}`);
  }
  const shot = await p1.screenshot();
  check("screenshot bytes", shot.length > 1000, `${shot.length}b`);
  const btn = (await p1.observe()).elements.find((e) => e.role === "button");
  if (btn) check("click ok", (await p1.click(btn.ref)).ok);

  // 2. Dynamic DOM stale recovery (spec §50) — deterministic: replace node AFTER observe
  const p2 = await browser.createPage(`${base}/dynamic.html`);
  const o2 = await p2.observe();
  const b2 = o2.elements.find((e) => e.role === "button");
  check("dynamic observe button", !!b2);
  if (b2) {
    // Force the DOM replacement synchronously (fixture's own setTimeout is timing-sensitive
    // and background throttling makes it racy — explicit replace is the deterministic core of §50).
    await p2.evaluate(`(() => { const old = document.querySelector("button"); old.replaceWith(old.cloneNode(true)); return true; })()`);
    const stale = await p2.click(b2.ref);
    check("stale detected", stale.ok === false && stale.error === "STALE_OBSERVATION", JSON.stringify(stale));
    const o3 = await p2.observe();
    const nb = o3.elements.find((e) => e.role === "button");
    check("re-observe new ref", !!nb && nb.ref.observationId !== b2.ref.observationId);
    if (nb) check("click fresh ref", (await p2.click(nb.ref)).ok);
  }

  // 3. Streaming text_stable (spec §51)
  const p3 = await browser.createPage(`${base}/streaming.html`);
  const w = await p3.wait({ kind: "text_stable", stableForMs: 500 }, { timeoutMs: 8000 });
  check("text_stable", w.ok, `${w.elapsedMs}ms`);
  const ex = await p3.extract();
  check("stream final content", ex.text.includes("complete"), ex.text.slice(0, 60));

  // 4. Mock-planner solve end-to-end
  const p4 = await browser.createPage(`${base}/basic.html`);
  const o4 = await p4.observe();
  const submit = o4.elements.find((e) => e.name.toLowerCase().includes("submit"));
  const planner = new MockPlanner(submit ? [submit.ref.id, "DONE"] : ["DONE"]);
  const res = await p4.solve("Click submit", {
    planner,
    verifier: async () => true,
    maxSteps: 5,
  });
  check("solve completed", res.status === "completed", `${res.status} steps=${res.steps}`);
} catch (e) {
  failures++;
  console.error("HARNESS ERROR", e);
} finally {
  await browser.disconnect();
  server.close();
}
console.log(failures === 0 ? "ALL INTEGRATION PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
