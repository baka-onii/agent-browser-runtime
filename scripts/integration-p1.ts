// P1 live test: uploads, downloads, cookies, dialogs, popup adoption, full-page shots.
// Run: npx tsx scripts/integration-p1.ts
import { createServer } from "node:http";
import { readFile, writeFile, stat, mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BrowserRuntime } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "browser");
const server = createServer(async (req, res) => {
  try {
    const name = (req.url ?? "/").split("?")[0]!.replace(/^\//, "") || "basic.html";
    if (name === "download.bin") {
      const data = Buffer.from("0123456789".repeat(5000));
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="payload.bin"',
        "Content-Length": data.length,
      });
      res.end(data);
      return;
    }
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

const dlDir = await mkdtemp(join(tmpdir(), "abr-dl-"));
const browser = await BrowserRuntime.connect({
  mode: "managed", headless: true,
  downloadsPath: dlDir,
  viewport: { width: 1120, height: 780 },
});
const events: { event: string; [k: string]: unknown }[] = [];
browser.on("download.completed", (e) => events.push(e));
browser.on("dialog.opened", (e) => events.push(e));
browser.on("dialog.handled", (e) => events.push(e));
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failures++;
};
try {
  // Upload
  const p1 = await browser.createPage(`${base}/upload.html`);
  const fileInput = (await p1.observe()).elements.find((e) => /choose file/i.test(e.name));
  check("upload observed", !!fileInput, JSON.stringify(fileInput));
  const tmp = join(tmpdir(), `abr-upload-${Date.now()}.txt`);
  await writeFile(tmp, "upload-contents");
  if (fileInput) {
    check("upload ok", (await p1.upload(fileInput.ref, [tmp])).ok);
    check("upload applied", (await p1.evaluate<string>("document.getElementById('n').textContent")).includes("1 file(s)"));
  }

  // Cookies (harness-level; fixture domain 127.0.0.1)
  const p2 = await browser.createPage(`${base}/basic.html`);
  await p2.setCookies([{ name: "abr_test", value: "yum", domain: "127.0.0.1" }]);
  check("cookies roundtrip", (await p2.cookies()).some((c) => c.name === "abr_test" && c.value === "yum"));
  await p2.clearCookies();
  check("cookies cleared", !(await p2.cookies()).some((c) => c.name === "abr_test"));

  // Dialogs (default: dismiss)
  const p3 = await browser.createPage(`${base}/dialog.html`);
  const alertBtn = (await p3.observe()).elements.find((e) => e.name === "Show alert")!;
  await p3.click(alertBtn.ref);
  await new Promise((r) => setTimeout(r, 500));
  check("alert auto-dismissed, page alive", (await p3.title()) === "alerted");
  check("dialog events", events.some((e) => e.event === "dialog.opened") && events.some((e) => e.event === "dialog.handled"));
  const confirmBtn = (await p3.observe()).elements.find((e) => e.name === "Show confirm")!;
  await p3.click(confirmBtn.ref);
  await new Promise((r) => setTimeout(r, 500));
  check("confirm dismissed→false branch", (await p3.title()) === "dismissed");

  // Popup adoption (_blank)
  const before = (await browser.pages()).length;
  const p4 = await browser.createPage(`${base}/popup.html`);
  const link = (await p4.observe()).elements.find((e) => e.role === "link")!;
  await p4.click(link.ref);
  let adopted = null;
  for (let i = 0; i < 40; i++) {
    const all = await browser.pages();
    adopted = all.find((x) => x.url.endsWith("/basic.html") && x.id !== p4.id) ?? null;
    if (adopted) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("popup adopted", !!adopted && (await browser.pages()).length === before + 2, JSON.stringify(adopted));

  // Download
  const p5 = await browser.createPage(`${base}/basic.html`);
  await p5.navigate(`${base}/download.bin`);
  let done = null;
  for (let i = 0; i < 60; i++) {
    done = events.find((e) => e.event === "download.completed") ?? null;
    if (done) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("download event", !!done, JSON.stringify(done));
  if (done?.path) check("download file exists", (await stat(String(done.path))).size === 50000, String(done.path));

  // Full-page screenshot
  const shot = await p1.screenshot({ fullPage: true });
  check("fullpage png", shot.length > 1000 && shot[1] === 0x50 && shot[2] === 0x4e, `${shot.length}b`);
} catch (e) {
  failures++;
  console.error("HARNESS ERROR", e);
} finally {
  await browser.disconnect();
  server.close();
}
console.log(failures === 0 ? "P1 ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
