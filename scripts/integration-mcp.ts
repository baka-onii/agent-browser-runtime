// MCP adapter live test: stdio NDJSON → initialize, tools/list, open/observe/extract/close.
// Run: npx tsx scripts/integration-mcp.ts
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "browser");
const fixtures = createServer(async (req, res) => {
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
await new Promise<void>((r) => fixtures.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(fixtures.address() as { port: number }).port}`;

const child = spawn("npx", ["tsx", "src/cli.ts", "mcp"],
  { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failures++;
};

let buf = "";
const pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();
let nextId = 0;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c: string) => {
  buf += c;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore */ }
  }
});
function req(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { message: string } }> {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const toolText = (r: { result?: unknown }): string =>
  ((r.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "");
try {
  const init = await req("initialize", {});
  check("mcp initialize", !!(init.result as { serverInfo?: unknown })?.serverInfo);
  const list = await req("tools/list", {});
  const tools = ((list.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
  check("tools/list", tools.includes("browser_open") && tools.includes("browser_solve"), `${tools.length} tools`);
  const opened = JSON.parse(toolText(await req("tools/call", { name: "browser_open", arguments: { url: `${base}/basic.html` } }))) as { id: string };
  check("browser_open", !!opened.id, opened.id);
  const obs = JSON.parse(toolText(await req("tools/call", { name: "browser_observe", arguments: { pageId: opened.id } }))) as { elements: { role: string }[] };
  check("browser_observe", obs.elements.length >= 2, `${obs.elements.length} els`);
  const box = (obs as { elements: { role: string; ref: { id: string; observationId: string; pageId: string } }[] }).elements.find((e) => e.role === "textbox")!;
  const typed = JSON.parse(toolText(await req("tools/call", { name: "browser_type", arguments: { pageId: opened.id, target: box.ref, text: "mcp-hi" } }))) as { ok: boolean };
  check("browser_type", typed.ok === true);
  const ext = JSON.parse(toolText(await req("tools/call", { name: "browser_extract", arguments: { pageId: opened.id } }))) as { text: string };
  check("browser_extract", ext.text.includes("Basic"));
  const bad = await req("tools/call", { name: "browser_nope", arguments: { pageId: opened.id } });
  check("unknown tool errors", !!bad.error || toolText(bad).includes("Unknown tool"));
  const closed = JSON.parse(toolText(await req("tools/call", { name: "browser_close", arguments: { pageId: opened.id } }))) as { ok: boolean };
  check("browser_close", closed.ok === true);
} catch (e) {
  failures++;
  console.error("HARNESS ERROR", e);
} finally {
  child.kill();
  fixtures.close();
}
console.log(failures === 0 ? "MCP ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
