# Changelog

## 0.1.0 — initial runtime

- Managed + attach Chromium sessions, multi-page tabs, navigation.
- Compact observations (minimal/agent/text/full), ephemeral `ElementRef`, semantic
  fingerprint separate from execution freshness (`pageKey` + guard + live node).
- Deterministic actions: click/type/press/scroll/select/hover/focus/extract/screenshot/
  evaluate/semantic waits incl. `text_stable`; uploads, downloads, cookies, dialogs.
- Stealth hygiene by default: launch flags, evasion init scripts, isolated-world reads,
  humanized input; `stealth-check` regression (sannysoft + live Google).
- OpenJev planner (single `/v1/systemone` Choice call, ≤120/head), text helper,
  `solve()` loop with budgets and caller-supplied verification.
- Loopback JSON-RPC 2.0 server + typed TS `RpcClient` + stdlib-only Python client.
- MCP adapter (`browser_*` tools over the public runtime API).
- Record/replay (`session.json`/`actions.jsonl`/`events.jsonl`) and run metrics.
- `abr` CLI: observe/screenshot/solve one-shots, `serve`, `rpc`, `mcp`, `chrome`, `replay`.
