#!/usr/bin/env node
// CLI: one-shot commands (observe/screenshot/solve) + persistent RPC server (serve)
// + generic RPC caller (rpc) for harness debugging.
// Each one-shot command connects → acts → disconnects → prints JSON.
import { Command } from "commander";
import { BrowserRuntime } from "./index.js";
import { replay } from "./recording.js";
import { RpcServer } from "./rpc/server.js";
import { McpServer } from "./mcp/server.js";
import { findChrome, chromeHelp } from "./transport.js";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const program = new Command();
program.name("abr").description("Agent Browser Runtime — one-shot CLI");

function connOpts(o: { managed?: boolean; port?: string; profile?: string }) {
  return {
    mode: (o.managed === false ? "attach" : "managed") as "attach" | "managed",
    browser: o.port ? { remoteDebugPort: Number(o.port) } : {},
    headless: false,
  };
}

program.command("observe <url>")
  .option("--no-managed", "attach to existing Chrome instead of launching")
  .option("--port <n>", "remote debugging port for attach")
  .option("--profile <p>", "observation profile", "agent")
  .action(async (url, o) => {
    const b = await BrowserRuntime.connect(connOpts(o));
    try {
      const p = await b.createPage(url);
      const obs = await p.observe({ profile: o.profile });
      console.log(JSON.stringify(obs, null, 2));
    } finally { await b.disconnect(); }
  });

program.command("screenshot <url>")
  .option("--out <f>", "output file", "shot.png")
  .option("--no-managed", "attach instead of launch")
  .action(async (url, o) => {
    const b = await BrowserRuntime.connect(connOpts(o));
    try {
      const p = await b.createPage(url);
      const buf = await p.screenshot();
      writeFileSync(o.out, buf);
      console.log(JSON.stringify({ ok: true, out: o.out }));
    } finally { await b.disconnect(); }
  });

program.command("solve <url> <goal...>")
  .option("--no-managed", "attach instead of launch")
  .option("--max-steps <n>", "max steps", "30")
  .action(async (url, goalParts: string[], o) => {
    const goal = goalParts.join(" ");
    const b = await BrowserRuntime.connect(connOpts(o));
    try {
      const p = await b.createPage(url);
      const r = await p.solve(goal, { maxSteps: Number(o.maxSteps) });
      console.log(JSON.stringify(r, null, 2));
    } finally { await b.disconnect(); }
  });

program.command("replay <dir>")
  .description("deterministically replay a recording (no planner; solve() steps fail clean)")
  .option("--no-managed", "attach instead of launch")
  .option("--port <n>", "remote debugging port for attach")
  .action(async (dir, o) => {
    const b = await BrowserRuntime.connect(connOpts(o));
    try {
      const r = await replay(b, dir, {
        onStep: (s) => console.log(`${s.ok ? "ok  " : "FAIL"} #${s.seq} ${s.op}${s.error ? ` — ${s.error}` : ""}`),
      });
      console.log(JSON.stringify(r));
      process.exit(r.failed === 0 ? 0 : 1);
    } finally { await b.disconnect(); }
  });

program.command("serve")
  .description("start the loopback JSON-RPC server (persistent browser session)")
  .option("--rpc-port <n>", "loopback port (0 = ephemeral)", "8765")
  .option("--no-managed", "attach to existing Chrome instead of launching")
  .option("--port <n>", "remote debugging port for attach")
  .option("--profile-dir <p>", "persistent Chrome profile dir (needed for DeepSeek login persistence)")
  .option("--executable-path <p>", "Chrome executable path")
  .option("--headless", "run headless (default: headed/visible)")
  .option("--proxy-server <url>", "HTTP(S) proxy, e.g. http://127.0.0.1:8080")
  .option("--locale <l>", "locale, e.g. en-US")
  .option("--timezone <tz>", "IANA timezone, e.g. America/New_York")
  .action(async (o) => {
    const server = new RpcServer({
      mode: (o.managed === false ? "attach" : "managed") as "attach" | "managed",
      browser: {
        ...(o.port ? { remoteDebugPort: Number(o.port) } : {}),
        ...(o.profileDir ? { profileDir: String(o.profileDir) } : {}),
        ...(o.executablePath ? { executablePath: String(o.executablePath) } : {}),
      },
      headless: o.headless === true,
      viewport: { width: 1280, height: 900 },
      ...(o.proxyServer ? { proxy: { server: String(o.proxyServer) } } : {}),
      ...(o.locale ? { locale: String(o.locale) } : {}),
      ...(o.timezone ? { timezone: String(o.timezone) } : {}),
    });
    const port = await server.start(Number(o.rpcPort));
    console.log(JSON.stringify({ ok: true, rpc: `http://127.0.0.1:${port}/`, events: `http://127.0.0.1:${port}/events` }));
    const shutdown = async () => { await server.stop(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await server.closed(); // also exits after server.shutdown RPC
    process.exit(0);
  });

program.command("rpc <method> [paramsJson]")
  .description("call one JSON-RPC method on a running server (e.g. abr rpc page.create '{\"url\":\"https://example.com\"}')")
  .option("--rpc-port <n>", "server port", "8765")
  .action(async (method, paramsJson, o) => {
    let params: Record<string, unknown> = {};
    try { params = paramsJson ? JSON.parse(paramsJson) as Record<string, unknown> : {}; }
    catch { console.error("Invalid params JSON"); process.exit(1); }
    const res = await fetch(`http://127.0.0.1:${Number(o.rpcPort)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program.command("mcp")
  .description("serve the MCP adapter over stdio (browser_* tools for AI harnesses)")
  .option("--no-managed", "attach to existing Chrome instead of launching")
  .option("--port <n>", "remote debugging port for attach")
  .action(async (o) => {
    const server = new McpServer({
      mode: (o.managed === false ? "attach" : "managed") as "attach" | "managed",
      browser: o.port ? { remoteDebugPort: Number(o.port) } : {},
      headless: false,
    });
    const shutdown = async () => { await server.close(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await server.serveStdio();
  });

program.command("chrome")
  .description("launch a debuggable headful Chrome (log in, then attach harnesses to it)")
  .option("--port <n>", "remote debugging port", "9222")
  .option("--profile-dir <d>", "persistent profile dir (logins survive)", "./.abr-debug-profile")
  .option("--url <u>", "open URL on launch", "about:blank")
  .action(async (o) => {
    const exe = findChrome();
    if (!exe) { console.error(chromeHelp()); process.exit(1); }
    const child = spawn(exe, [
      `--remote-debugging-port=${o.port}`,
      `--user-data-dir=${o.profileDir}`,
      "--no-first-run", "--no-default-browser-check",
      o.url,
    ], { stdio: "ignore" });
    console.log(JSON.stringify({ ok: true, pid: child.pid, debug: `http://127.0.0.1:${o.port}/json/version`, profileDir: o.profileDir }));
    console.log(`Attach with: abr observe <url> --no-managed --port ${o.port}`);
    const kill = () => { try { child.kill(); } catch { /* ignore */ } process.exit(0); };
    process.on("SIGINT", kill);
    process.on("SIGTERM", kill);
    await new Promise(() => {}); // run until signal
  });

program.parseAsync(process.argv);
