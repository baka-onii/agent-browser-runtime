# AGENTS.md — agent-browser-runtime

General browser-execution runtime (deterministic automation + optional OpenJev planning).
Single TS package. Public API in `src/index.ts` — never import internals from outside.

## Commands

```bash
npm install
npm run build        # tsc → dist/
npx tsc --noEmit     # typecheck
npx vitest run tests/unit
npx tsx scripts/integration.ts   # local fixtures + managed headless Chrome (auto-detected)
npx tsx scripts/integration-p1.ts # uploads/downloads/cookies/dialogs/popups/fullpage
npx tsx scripts/integration-rpc.ts # loopback JSON-RPC server + typed client round trip
npx tsx scripts/integration-mcp.ts # MCP stdio adapter round trip
npx tsx scripts/integration-record.ts # record/replay + metrics + health
python python/tests/test_live.py # same round trip through the Python client
npx tsx scripts/stealth-check.ts # external: sannysoft + live Google (residential IP assumed)
npx tsx scripts/deepseek-live.ts # headed, persistent profile; waits for manual login if needed
```

## Usage (public API only)

```ts
import { BrowserRuntime } from "agent-browser-runtime"; // or ../src/index.js in-repo

const browser = await BrowserRuntime.connect({ mode: "managed" }); // or "attach"
const page = await browser.createPage("https://example.com");
const obs = await page.observe({ profile: "agent" });              // minimal|agent|text|full
const box = obs.elements.find(e => e.role === "textbox");
await page.type(box.ref, "hello");   // refs are ephemeral: re-observe after DOM changes
await page.press("Enter");
await page.wait({ kind: "text_stable", stableForMs: 800 }, { timeoutMs: 20000 });
const { text } = await page.extract();
await browser.disconnect();

// Agentic fallback (needs TYPESAFE_API_KEY; MockPlanner/RulePlanner work without keys)
await page.solve("Do X", { verifier: async (_goal, obs) => /* deterministic check */ true });
```

## Rules that must not be broken

1. **Never couple consumers to CDP.** Public surface = `BrowserRuntime`/`Page`/types only.
   Raw CDP exists (`browser.transportRaw().send()`) as a privileged escape hatch, never for the planner.
2. **ElementRef is ephemeral** (`{id, observationId, pageId}`). `STALE_OBSERVATION` → `observe()` again,
   never retry blindly. Rich `ObservedAction` (node identity, geometry, guards) stays in `src/`, never exported.
3. **Model output is never executable.** Planner may only return observed action IDs (`e7`, `scroll_down`,
   `wait`, `DONE`, `BLOCKED`); target heads capped at 120 choices. No selectors/coords/JS from models.
4. **`DONE` ≠ success.** `solve()` requires a caller-supplied deterministic `verifier`; model verifier is
   opt-in only (`useModelVerifier`), never default.
5. **Stealth is hygiene, not warfare.** Defaults: `stealth: true, humanize: true`
   (launch flags, evasion init scripts, isolated-world reads, humanized input).
   Never overwrite a healthy native value with a spoof (past self-inflicted tells: webdriver getter,
   PluginArray). Out of scope: defeating hardened endpoints, CAPTCHAs.
6. **Observation is compact.** Never dump full DOM to models; `maxTokens` trims text first, then tail
   elements; passwords redacted. Iframes: discover via `page.frames()`, act = `CapabilityError`.
   Shadow DOM: unsupported, must fail clean, never silent.
7. **Budgets fail closed.** `maxSteps/maxElapsedMs/maxPlannerCalls` + `AbortSignal` on long ops.
   Retry only `STALE_OBSERVATION`/`PAGE_LOADING`/`TARGET_NOT_READY`/`NETWORK_TRANSIENT`.

## RPC (loopback JSON-RPC 2.0 — the non-Node harness boundary)

```bash
abr serve --rpc-port 8765            # persistent server, owns one browser session
abr serve --rpc-port 0 --profile-dir <dir> [--executable-path <chrome>]  # ephemeral port + persistent login profile (DeepSeek)
abr rpc page.create '{"url":"https://example.com"}' --rpc-port 8765
```

```ts
import { RpcClient } from "agent-browser-runtime";
const c = new RpcClient("http://127.0.0.1:8765");
const { id } = await c.createPage("https://example.com");
const obs = await c.observe(id, "agent");   // same PageObservation JSON as in-process
await c.type(id, obs.elements[0].ref, "hello");
```

Rules: bind is `127.0.0.1` only, never `0.0.0.0`. Error contract mirrors in-process —
unknown observation IDs throw `RpcError` (`data.errorCode: "STALE_OBSERVATION"`),
known-but-mutated refs return `{ok:false, error:"STALE_OBSERVATION"}`. `solve()` over RPC
takes a serializable verifier (`{urlContains?, textContains?}`), never a callback —
unverified `DONE` still never reports `completed`.

```bash
pip install ./python   # stdlib-only Python client (agent_browser_runtime.RpcClient)
```

```python
from agent_browser_runtime import RpcClient
c = RpcClient("http://127.0.0.1:8765")
page = c.create_page("https://example.com")
obs = c.observe(page["id"], "agent")
box = next(e for e in obs["elements"] if e["role"] == "textbox")
c.type(page["id"], box["ref"], "hello")
```

## Layout

- `src/browser.ts`, `page.ts`, `engine.ts` — runtime core
- `src/observation.ts`, `snapshot.ts`, `state.ts` — observation (fingerprint ≠ freshness proof)
- `src/transport.ts` — direct CDP (`ws`); isolated worlds; dead-context retry
- `src/stealth/evasions.ts` — init scripts, gap-patching only
- `src/planner/` — `planner.ts` (interfaces + Mock/Rule), `openjev.ts`, `textHelper.ts`, `prompts.ts`
- `src/solve.ts`, `verifier.ts`, `errors.ts`, `events.ts`, `config.ts`, `logger.ts`, `cli.ts`
- `src/rpc/` — `server.ts` (loopback JSON-RPC 2.0), `client.ts` (typed `RpcClient`)
- `src/mcp/` — `server.ts` (stdio adapter, `browser_*` tools)
- `src/recording.ts` (`Recorder` + `replay()`), `src/metrics.ts` (`browser.metricsSummary()`)
- `scripts/` — `integration.ts`, `stealth-check.ts` (re-run per Chrome bump), `deepseek-live.ts`
- `tests/browser/*.html` — local fixtures; `tests/unit/` — fingerprint/caps/observation tests

## Env vars

`TYPESAFE_API_KEY` (or `OPENJEV_API_KEY`) + `TYPESAFE_MODEL` (default `jev-latest`);
`TEXT_MODEL_API_KEY`, `TEXT_MODEL_BASE_URL`, `TEXT_MODEL` (field-value helper).
Chrome is auto-detected (`ABR_CHROME_PATH` env → well-known OS paths → PATH); override per
connection via `browser.executablePath`.
