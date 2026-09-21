// Record/replay + metrics live test.
// Run: npx tsx scripts/integration-record.ts
import { createServer } from "node:http";
import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BrowserRuntime } from "../src/index.js";
import { replay } from "../src/recording.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "browser");
const server = createServer(async (req, res) => {
  try {
    const name = (req.url ?? "/").split("?")[0]!.replace(/^\//, "") || "basic.html";
    const data = await readFile(join(root, name));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    try { res.end("nf"); } catch { /* gone */ }
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = await mkdtemp(join(tmpdir(), "abr-rec-"));

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failures++;
};

// Record a deterministic flow.
const b1 = await BrowserRuntime.connect({ mode: "managed", headless: true });
try {
  b1.startRecording(dir);
  const p = await b1.createPage(`${base}/basic.html`);
  const obs = await p.observe();
  await p.type(obs.elements.find((e) => e.role === "textbox")!.ref, "replay-me");
  await p.press("Enter");
  await p.wait({ kind: "text_present", text: "Basic" }, { timeoutMs: 5000 });
  const m = b1.metricsSummary();
  check("metrics actions", m.actionsTotal >= 2 && m.actionsOk >= 2, JSON.stringify({ total: m.actionsTotal, ok: m.actionsOk }));
  check("metrics tokens", m.observationTokens > 0, `${m.observationTokens} tokens`);
  check("metrics latency", m.meanActionLatencyMs >= 0 && m.p95ActionLatencyMs >= m.p50ActionLatencyMs, `p50=${m.p50ActionLatencyMs} p95=${m.p95ActionLatencyMs}`);
} finally {
  b1.stopRecording();
  await b1.disconnect();
}
const files = await readdir(dir);
check("recording files", files.includes("session.json") && files.includes("actions.jsonl") && files.includes("events.jsonl"), files.join(","));
const obsFiles = await readdir(join(dir, "observations"));
check("observations saved", obsFiles.length > 0, `${obsFiles.length} files`);

// Replay into a fresh browser.
const b2 = await BrowserRuntime.connect({ mode: "managed", headless: true });
try {
  const steps: string[] = [];
  const r = await replay(b2, dir, { onStep: (s) => steps.push(`${s.ok ? "ok" : "FAIL"} #${s.seq} ${s.op}${s.error ? ` — ${s.error}` : ""}`) });
  console.log(steps.join("\n"));
  check("replay all ok", r.failed === 0 && r.steps >= 3, `${r.steps - r.failed}/${r.steps}`);
  const m2 = b2.metricsSummary();
  check("replay metrics", m2.actionsTotal >= 2, `${m2.actionsTotal} actions`);
  check("health", (await b2.health()).ok === true);
} finally {
  await b2.disconnect();
  server.close();
}
console.log(failures === 0 ? "RECORD ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
