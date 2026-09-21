# agent-browser-runtime

General browser-execution runtime for deterministic automation **and** AI agents — one clean
API over Chromium, with human-like transport hygiene, optional OpenJev planning, a loopback
JSON-RPC boundary, and Python + MCP harnesses. See `spec.md` for the full specification
and `AGENTS.md` for contributor/agent rules.

## Install

Requires Node 20+ and a Chrome/Chromium install (auto-detected on Windows, macOS, Linux).
Override with `browser.executablePath` if needed.

```bash
npm install agent-browser-runtime
```

Python client (stdlib only, talks to the RPC server):

```bash
pip install ./python   # from this repo; publishes as agent-browser-runtime
```

## Quickstart

```ts
import { BrowserRuntime } from "agent-browser-runtime";

const browser = await BrowserRuntime.connect({ mode: "managed" }); // isolated profile
const page = await browser.createPage("https://example.com");
const obs = await page.observe({ profile: "agent" });
const box = obs.elements.find(e => e.role === "textbox");
await page.type(box.ref, "hello");
await page.press("Enter");
await page.wait({ kind: "text_stable", stableForMs: 800 }, { timeoutMs: 20000 });
console.log((await page.extract()).text.slice(0, 500));
await browser.disconnect();
```

Keep a login between runs with a persistent profile:

```ts
const browser = await BrowserRuntime.connect({
  mode: "managed",
  browser: { profileDir: "./.abr-profile" },   // reused across runs
  headless: false,                             // visible for first login
});
```

Attach to your own debuggable Chrome instead (one-command launcher included):

```bash
abr chrome --port 9222        # headful Chrome you can log into and inspect
abr solve <url> "goal…" --no-managed --port 9222
```

## CLI

```bash
abr observe <url> | abr screenshot <url> --out shot.png | abr solve <url> "goal…"
abr serve --rpc-port 8765     # persistent loopback JSON-RPC server
abr rpc page.create '{"url":"https://example.com"}' --rpc-port 8765
abr mcp                       # MCP stdio adapter (browser_* tools)
abr chrome --port 9222        # debuggable headful Chrome for attach mode
abr replay ./run-1            # deterministic replay of a recording
```

## RPC + Python (non-Node harnesses)

```ts
import { RpcClient } from "agent-browser-runtime";
const c = new RpcClient("http://127.0.0.1:8765");
const { id } = await c.createPage("https://example.com");
```

```python
from agent_browser_runtime import RpcClient
c = RpcClient("http://127.0.0.1:8765")
page = c.create_page("https://example.com")
```

Bind is `127.0.0.1` only. Unknown observation IDs raise `RpcError`
(`data.errorCode: "STALE_OBSERVATION"`); mutated refs return
`{ok: false, error: "STALE_OBSERVATION"}`. `solve()` over RPC takes a serializable
verifier (`urlContains`/`textContains`) — unverified `DONE` never reports `completed`.

## Agentic mode (optional OpenJev)

```ts
await page.solve("Search for cats and open the first result.", {
  verifier: async (_goal, obs) => obs.url.includes("search"),
});
```

Needs `TYPESAFE_API_KEY` (or `OPENJEV_API_KEY`); without keys, `MockPlanner`/`RulePlanner`
keep the loop testable. Model output is never executable: only observed action IDs.
Field text comes from a small helper model (`TEXT_MODEL_*`); `DONE` always requires the
caller verifier (model verifier is opt-in via `useModelVerifier`, never default).

## Config highlights

`stealth: true, humanize: true` by default (launch flags, evasion init scripts,
isolated-world reads, humanized input). Bounded goal: look like ordinary Chrome on normal
sites — hardened bot-mitigation endpoints and CAPTCHAs are out of scope.
`allowedOrigins`, `allowRawCdp`, `allowNavigation`, `allowDownloads`, `allowUploads`,
`proxy`, `locale`/`timezone` round out the policy surface.

## Scripts

| Script | What |
|---|---|
| `npx tsx scripts/integration.ts` | local fixtures + managed Chrome, deterministic suite |
| `npx tsx scripts/integration-p1.ts` | uploads/downloads/cookies/dialogs/popups/fullpage |
| `npx tsx scripts/integration-rpc.ts` | loopback server + TS client round trip |
| `npx tsx scripts/integration-mcp.ts` | MCP stdio adapter round trip |
| `npx tsx scripts/integration-record.ts` | record/replay + metrics + health |
| `python python/tests/test_live.py` | same round trip through the Python client |
| `npx tsx scripts/stealth-check.ts` | sannysoft + live Google (residential IP; re-run per Chrome bump) |
| `npx tsx scripts/deepseek-live.ts` | headed persistent-profile chat round trip |

## Operability

```ts
browser.startRecording("./run-1");   // session.json/actions.jsonl/events.jsonl/observations/
await page.type(...);                // …do work…
browser.stopRecording();
abr replay ./run-1                  // deterministic replay, no planner
browser.metricsSummary();           // actions/stale/planner/latency p50+p95/tokens per §38
await browser.health();             // {ok, latencyMs} — reconnect when false
```

`logFile: "./abr.log"` in connect options appends JSON log lines alongside console output.

## Layout

`src/browser.ts`, `page.ts`, `engine.ts`, `transport.ts`, `observation.ts`, `snapshot.ts`,
`state.ts`, `stealth/evasions.ts`, `planner/`, `rpc/`, `mcp/`, `recording.ts`, `metrics.ts`,
`solve.ts`, `cli.ts`. Public API is `src/index.ts` — internals (`ObservedAction` node
identity, guards, CDP) never leak to consumers.
