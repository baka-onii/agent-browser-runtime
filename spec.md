# Agent Browser Runtime

## Technical Specification v0.1

### 1. Purpose

Build a standalone, reusable browser-automation runtime that can be attached to unrelated software projects as a module.

The runtime must support two modes:

1. **Programmatic mode** — deterministic browser automation controlled entirely by application code.
2. **Agentic mode** — an application supplies a natural-language objective and the runtime can use OpenJev to select browser actions from the currently observed page.

The browser runtime is **not a DeepSeek, ChatGPT, or website-specific adapter**. It must operate against arbitrary web pages.

The intended architecture is:

```text
                    Application / AI Harness
                              │
                    ┌─────────┴─────────┐
                    │                   │
             Programmatic API      Agent API
                    │                   │
                    └─────────┬─────────┘
                              │
                    Agent Browser Runtime
                              │
             ┌────────────────┼────────────────┐
             │                │                │
        State Manager    Observation      Action Engine
             │                │                │
             └────────────────┼────────────────┘
                              │
                        Browser Transport
                              │
                     Browser Harness / CDP
                              │
                           Chromium
                              │
                            Web
```

The runtime must remain useful even when OpenJev is completely disabled.

---

# 2. Design Goals

## 2.1 Primary goals

The system MUST:

* control Chromium programmatically;
* attach to an existing browser or launch an isolated browser;
* support multiple tabs/pages;
* expose a clean language-level API;
* expose a language-agnostic local RPC interface;
* navigate, inspect, interact, extract, and observe pages;
* maintain stable browser sessions;
* represent interactive elements using ephemeral runtime references;
* detect stale page state before executing actions;
* recover from normal DOM/UI mutations by re-observing;
* support deterministic actions without an LLM;
* optionally use OpenJev for action selection;
* expose screenshots and page state;
* expose raw CDP access as an escape hatch;
* emit structured events for logging and harness integration;
* be safe to embed into larger automation systems;
* keep browser-specific implementation details out of consuming applications;
* present no bot fingerprint during normal browsing (human-like transport hygiene),
  so first-party harnesses such as `web_search` get the same access as a human-driven Chrome.

## 2.2 Secondary goals

The system SHOULD:

* minimize context sent to AI models;
* minimize browser protocol round trips;
* keep observations compact;
* provide token estimates for agent observations;
* allow applications to cache observations;
* support reproducible runs and recordings;
* expose sufficient information for evaluation and benchmarking.

## 2.3 Non-goals

The first version MUST NOT attempt to:

* implement a Chromium browser engine;
* replace Chrome/CDP;
* implement a full browser UI;
* defeat hardened anti-bot endpoints (Cloudflare challenges, DataDome, PerimeterX);
* solve CAPTCHAs automatically;
* provide website-specific automation adapters;
* make OpenJev mandatory;
* become a full autonomous reasoning framework.

Stealth is a bounded core feature, not an arms-race program: the runtime must look like
an ordinary human-driven Chrome during normal browsing (search engines, normal web results),
via launch hygiene, fingerprint-surface evasions, CDP-minimal evaluation, and humanized input.
Defeating hardened bot-mitigation endpoints and solving CAPTCHAs remain out of scope.

---

# 3. Core Architectural Principle

The public API MUST NOT depend directly on OpenJev, Browser Harness internals, or raw CDP method names.

The dependency direction must be:

```text
Application
    ↓
Public Browser API
    ↓
Runtime Core
    ↓
Transport Interface
    ↓
Browser Harness / CDP
```

OpenJev sits beside the runtime:

```text
               Runtime Core
                    │
          ┌─────────┴─────────┐
          │                   │
   Deterministic        Agent Planner
      Actions           (OpenJev)
          │                   │
          └─────────┬─────────┘
                    ↓
              Action Engine
```

This allows the runtime to replace Browser Harness, OpenJev, or even Chromium later without breaking the application's API.

Browser Harness JS is particularly suitable as the initial transport because it deliberately exposes the typed CDP surface and keeps a persistent session rather than imposing a large browser abstraction. Its current SDK exposes the Chrome protocol through generated typed wrappers and maintains session/target state across calls.

---

# 4. Recommended Implementation Stack

## 4.1 Reference implementation

Use:

```text
TypeScript / Node.js
        +
browser-harness-js
        +
Chromium
        +
OpenJev-compatible HTTP client
```

Reason:

* browser-harness-js is already TypeScript;
* CDP types can be generated from Chrome's protocol;
* TypeScript provides a strong public SDK boundary;
* OpenJev can remain an HTTP/provider dependency instead of being coupled into browser code.

Browser Harness JS currently exposes a persistent CDP session and generated wrappers for the Chrome DevTools Protocol, making it a suitable low-level transport rather than a high-level automation abstraction.

## 4.2 Python support

The system SHOULD expose a Python client over the local RPC protocol.

This lets a Python AI harness use:

```python
browser = BrowserRuntime.connect()
browser.navigate(...)
browser.observe(...)
browser.solve(...)
```

without embedding Node.js into the Python application.

The Python client is a transport client, not a second browser implementation.

---

# 5. Package Structure

Single publishable package (monorepo deferred — one package keeps the public
boundary strict while the internals evolve):

```text
agent-browser-runtime/
├── src/
│   ├── index.ts          # public API only (consumers import this and nothing else)
│   ├── browser.ts        # BrowserRuntime: sessions, tabs, popup adoption
│   ├── page.ts           # Page API: navigate/observe/act/extract/wait/solve
│   ├── engine.ts         # ActionEngine: freshness proof → concrete CDP input
│   ├── transport.ts      # direct CDP (ws); launch/attach; isolated worlds
│   ├── stealth/
│   │   └── evasions.ts   # gap-patching init scripts (bounded stealth, §2.1)
│   ├── planner/          # Planner interfaces + OpenJev/TextHelper/Mock/Rule
│   ├── rpc/              # loopback JSON-RPC 2.0 server + typed RpcClient
│   ├── mcp/              # MCP stdio adapter (translates into the public API)
│   ├── recording.ts      # record/replay (§36)
│   ├── metrics.ts        # run metrics (§38)
│   ├── observation.ts / snapshot.ts / state.ts / element.ts / action.ts
│   ├── solve.ts / verifier.ts (waits live in page.ts)
│   ├── errors.ts / events.ts / config.ts / logger.ts / cli.ts
├── python/               # stdlib-only RpcClient (transport client, not a reimplementation)
├── scripts/              # integration / stealth-check / record harnesses
├── tests/browser/*.html  # local fixtures (no external sites for CI)
├── tests/unit/           # fingerprint/caps/observation/protocol/metrics tests
├── README.md / AGENTS.md / CHANGELOG.md / LICENSE
```

The planner stays swappable behind the `Planner` interface; MCP/RPC/Python are
adapters over the public API, never second implementations.

---

# 6. Public API

The API should be intentionally small.

## 6.1 BrowserRuntime

```ts
interface BrowserRuntime {
    connect(options?: ConnectOptions): Promise<BrowserRuntime>;
    disconnect(): Promise<void>;

    pages(): Promise<Page[]>;
    page(id?: string): Promise<Page>;

    createPage(url?: string): Promise<Page>;
    closePage(id: string): Promise<void>;

    on<T extends BrowserEvent>(
        event: T,
        callback: EventHandler<T>
    ): Unsubscribe;

    capabilities(): BrowserCapabilities;

    transport(): RawTransport;
}
```

Typical usage:

```ts
const browser = await BrowserRuntime.connect();

const page = await browser.createPage(
    "https://example.com"
);

const state = await page.observe();

await page.click(state.elements[3]);

await browser.disconnect();
```

---

# 7. Page API

```ts
interface Page {
    id: string;

    url(): Promise<string>;
    title(): Promise<string>;

    navigate(url: string, options?: NavigateOptions): Promise<NavigationResult>;
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;

    observe(options?: ObserveOptions): Promise<PageObservation>;

    click(target: ElementRef | Locator): Promise<ActionResult>;
    type(
        target: ElementRef | Locator,
        text: string
    ): Promise<ActionResult>;

    press(
        key: string
    ): Promise<ActionResult>;

    scroll(
        options: ScrollOptions
    ): Promise<ActionResult>;

    select(
        target: ElementRef | Locator,
        option: SelectOption
    ): Promise<ActionResult>;

    hover(target: ElementRef | Locator): Promise<ActionResult>;

    focus(target: ElementRef | Locator): Promise<ActionResult>;

    extract(
        target?: ElementRef | Locator,
        options?: ExtractOptions
    ): Promise<ExtractedContent>;

    screenshot(
        options?: ScreenshotOptions
    ): Promise<Buffer>;

    evaluate<T = unknown>(
        expression: string
    ): Promise<T>;

    wait(
        condition: WaitCondition,
        options?: WaitOptions
    ): Promise<WaitResult>;

    solve(
        task: string,
        options?: SolveOptions
    ): Promise<SolveResult>;
}
```

The API MUST provide deterministic operations independent of AI.

---

# 8. Element References

The runtime MUST NOT expose DOM nodes directly to consuming applications.

Instead it uses:

```ts
type ElementRef = {
    id: string;
    observationId: string;
    pageId: string;
};
```

Example:

```json
{
    "id": "e17",
    "observationId": "obs_8f92",
    "pageId": "page_01"
}
```

Element references are intentionally ephemeral.

They are valid only while the referenced observation remains fresh.

An application must therefore do:

```ts
const observation = await page.observe();

await page.click(
    observation.elements.find(
        e => e.role === "button" && e.name === "Send"
    ).ref
);
```

rather than assuming `e17` will remain valid forever.

---

# 9. Locators

The runtime SHOULD support deterministic locators:

```ts
type Locator =
    | {
        kind: "role";
        role: string;
        name?: string;
    }
    | {
        kind: "text";
        text: string;
    }
    | {
        kind: "css";
        selector: string;
    }
    | {
        kind: "xpath";
        expression: string;
    };
```

Preferred ordering:

```text
role/name
   ↓
text
   ↓
stable attributes
   ↓
CSS
   ↓
XPath
```

Locators are application-controlled.

They are NEVER produced directly by OpenJev.

OpenJev only selects from the currently observed action space.

---

# 10. Observation System

The observation layer is the most important component.

It MUST provide a compact, structured representation of the current page.

Example:

```json
{
    "observationId": "obs_8123",
    "pageId": "page_01",
    "url": "https://example.com/chat",
    "title": "Example",
    "readyState": "complete",
    "fingerprint": "a91c...",
    "elements": [
        {
            "ref": "e1",
            "role": "textbox",
            "name": "Message",
            "value": ""
        },
        {
            "ref": "e2",
            "role": "button",
            "name": "Send",
            "enabled": true
        }
    ],
    "text": "Welcome to Example...",
    "scroll": {
        "x": 0,
        "y": 420,
        "maxY": 1800
    }
}
```

The observation SHOULD include:

* URL;
* title;
* visible text;
* interactive elements;
* roles;
* accessible-ish names;
* current values;
* disabled state;
* visibility;
* bounding geometry;
* element type;
* relevant attributes;
* scroll position;
* page fingerprint;
* frame identity where applicable.

The observation MUST avoid dumping the full DOM by default.

---

# 11. Observation Profiles

Provide several profiles.

## `minimal`

For deterministic programs:

```text
URL
title
interactive elements
```

## `agent`

For OpenJev:

```text
visible controls
roles
names
values
relevant surrounding text
action compatibility
```

## `text`

For extraction:

```text
visible readable content
```

## `full`

For diagnostics/debugging:

```text
DOM + attributes + geometry + frames + metadata
```

Example:

```ts
await page.observe({
    profile: "agent"
});
```

---

# 12. Action Model

Actions MUST be typed.

```ts
type BrowserAction =
    | ClickAction
    | TypeAction
    | PressAction
    | ScrollAction
    | SelectAction
    | HoverAction
    | FocusAction
    | NavigateAction
    | WaitAction
    | ExtractAction
    | ScreenshotAction
    | DoneAction;
```

Example:

```json
{
    "kind": "click",
    "target": "e17"
}
```

Typing:

```json
{
    "kind": "type",
    "target": "e4",
    "text": "hello"
}
```

OpenJev MUST return only validated structured actions.

It must never return:

```text
raw JavaScript
shell commands
arbitrary selectors
arbitrary coordinates
```

unless explicitly requested through a separate privileged API.

This follows the useful property demonstrated by the Jev Ultrafast architecture: model output represents actions over an observed action space rather than arbitrary browser code, while the executor validates the current DOM target before performing the action.

---

# 13. Freshness / Stale State

Every observation receives a fingerprint.

Example:

```text
DOM identity
+
URL
+
relevant visible controls
+
selected form state
+
document marker
```

The exact hashing algorithm is implementation-defined.

Before executing an action:

```text
action references observation N
             │
             ▼
       current page
             │
       fingerprint?
        /          \
     same          different
      │                │
      ▼                ▼
   execute          STALE
```

If stale, return:

```ts
{
    ok: false,
    error: "STALE_OBSERVATION",
    observationId: "obs_old"
}
```

Do not blindly execute.

The caller can then:

```ts
const current = await page.observe();
```

For agentic operation, the runtime SHOULD automatically re-plan after a stale observation.

This mirrors the central mechanism used by `jev-ultrafast`, which retains actual DOM-node identity, checks freshness before execution, and re-observes after a stale-page failure.

---

# 14. OpenJev Planner

OpenJev is an optional planner implementation.

It MUST conform to:

```ts
interface ActionPlanner {
    plan(
        goal: string,
        observation: PageObservation,
        history: ActionHistory
    ): Promise<PlannerResult>;
}
```

Result:

```ts
type PlannerResult = {
    action:
        | BrowserAction
        | "DONE"
        | "BLOCKED";
    confidence?: number;
    reasoning?: never;
    raw?: unknown;
};
```

The public runtime MUST NOT require chain-of-thought or free-form model reasoning.

OpenJev should receive:

```text
goal
+
compact observation
+
available operations
+
action constraints
```

and return a typed choice.

OpenJev-compatible System One APIs use typed decision questions rather than ordinary chat generation; the current OpenJev implementation exposes `/v1/systemone` with Choice, Score, and Noul-style questions.

The planner adapter SHOULD therefore map browser decisions into a constrained Choice space:

```text
CLICK:e1
CLICK:e2
TYPE:e3
PRESS:e3:ENTER
SCROLL:DOWN
WAIT
DONE
```

Do not ask the model to invent arbitrary browser commands.

---

# 15. OpenJev Is Not the Browser Brain

The runtime itself MUST implement the following deterministically:

* DOM observation;
* visibility checking;
* target resolution;
* stale detection;
* geometry checking;
* clickability checking;
* enabled/disabled checks;
* execution;
* waiting;
* navigation;
* screenshotting;
* result verification.

OpenJev should answer:

> "Given this state and this goal, which valid action should happen next?"

It should NOT answer:

> "How do I technically send a mouse event?"

The browser runtime handles that.

---

# 16. `solve()` API

Example:

```ts
const result = await page.solve(
    "Find the message box, type 'hello world', and send it."
);
```

Internally:

```text
observe
   ↓
construct action space
   ↓
OpenJev
   ↓
validate action
   ↓
execute
   ↓
wait for useful state
   ↓
observe again
   ↓
verify
   ↓
repeat
```

Result:

```json
{
    "status": "completed",
    "steps": 4,
    "elapsedMs": 1830,
    "actions": [
        "TYPE e1",
        "CLICK e2"
    ]
}
```

Possible statuses:

```text
completed
failed
blocked
timeout
max_steps
stale
cancelled
```

---

# 17. Verification

Never treat:

```text
OpenJev says DONE
```

as proof that the task succeeded.

The runtime MUST have a verification stage.

Example:

```text
Goal:
"Send message 'hello'"

Model:
CLICK Send
DONE

Runtime:
Did a new message appear?
Did input clear?
Did network/UI state change?
```

Only then:

```text
status = completed
```

The existing Jev Ultrafast implementation explicitly treats `DONE` as requiring independent outcome verification, which should be retained as a design principle.

---

# 18. Waiting System

Avoid arbitrary sleeps:

```ts
await sleep(5000);
```

Provide semantic waits:

```ts
await page.wait({
    until: {
        kind: "element_visible",
        locator: {
            kind: "role",
            role: "button",
            name: "Submit"
        }
    }
});
```

Other conditions:

```text
element_visible
element_hidden
text_present
text_changed
url_matches
network_idle
document_ready
generation_finished
custom_js
timeout
```

Every wait must have a timeout.

---

# 19. Streaming / Dynamic Web Applications

The runtime MUST support continuously mutating interfaces.

Typical example:

```text
user submits prompt
      ↓
assistant starts streaming
      ↓
DOM text changes repeatedly
      ↓
assistant finishes
```

Do not treat every DOM mutation as a failure.

The runtime should distinguish:

```text
structural mutation
vs
content mutation
```

Applications may request:

```ts
page.wait({
    until: {
        kind: "text_stable",
        target: responseElement,
        stableForMs: 500
    }
});
```

This allows generic automation of chat applications without creating a site-specific DeepSeek adapter.

---

# 20. Browser Sessions

A `BrowserSession` represents a running Chromium context.

Configuration:

```ts
type BrowserConfig = {
    mode: "attach" | "managed";

    browser?: {
        executablePath?: string;
        profileDir?: string;
        remoteDebugPort?: number;
    };

    headless?: boolean;

    viewport?: {
        width: number;
        height: number;
        deviceScaleFactor?: number;
    };

    persistence?: {
        enabled: boolean;
        directory?: string;
    };
};
```

Two modes:

### Attach

Attach to an existing Chrome instance.

Useful for:

* existing logins;
* human-in-the-loop workflows;
* development;
* debugging.

### Managed

Launch a dedicated Chromium instance with an isolated profile.

Preferred for:

* unattended automation;
* testing;
* reproducible harness runs.

---

# 21. Tabs

Each tab/page gets an immutable runtime ID.

```ts
type PageId = string;
```

Never assume CDP target ordering corresponds to visible tab order.

Expose:

```ts
browser.pages()
```

returning:

```json
[
    {
        "id": "page_1",
        "url": "...",
        "title": "..."
    }
]
```

Applications choose explicitly.

---

# 22. Frames

MVP:

* main frame supported;
* iframe discovery exposed;
* frame IDs represented explicitly.

Example:

```ts
page.frames()
```

Future:

```ts
frame.observe()
frame.click(...)
frame.type(...)
```

The system MUST not silently act inside an iframe as though it belonged to the main document.

---

# 23. Shadow DOM

MVP:

* open shadow roots SHOULD be traversable;
* closed shadow roots remain unsupported.

The observation layer should record the DOM path required to locate the actual element.

---

# 24. Raw CDP Escape Hatch

The runtime MUST provide an escape hatch:

```ts
browser.transport().send(
    "Runtime.evaluate",
    {
        expression: "..."
    }
);
```

However:

* application code may use it;
* OpenJev MUST NOT receive unrestricted raw CDP access by default.

This preserves the power of Browser Harness/CDP while preventing the high-level runtime from becoming crippled by its own abstraction.

Browser Harness JS intentionally keeps CDP as the low-level API and generates typed wrappers for the protocol; the runtime should preserve that philosophy beneath its own stable abstraction.

---

# 25. Event System

Expose structured events:

```text
browser.connected
browser.disconnected

page.created
page.closed
page.navigated

observation.created
observation.invalidated

action.started
action.completed
action.failed

planner.started
planner.completed

wait.started
wait.completed

task.started
task.completed
task.failed
```

Example:

```ts
browser.on("action.completed", event => {
    logger.info(event);
});
```

Events should include timestamps and IDs.

---

# 26. Cancellation

Every long-running operation MUST accept an `AbortSignal`.

Example:

```ts
const controller = new AbortController();

await page.solve(
    "Complete the task",
    {
        signal: controller.signal,
        maxSteps: 30
    }
);
```

Cancellation must stop:

* model calls where possible;
* waits;
* browser loops;
* task execution.

---

# 27. Limits

All agentic execution MUST have configurable limits:

```ts
{
    maxSteps: 30,
    maxElapsedMs: 60_000,
    maxPlannerCalls: 30,
    maxScreenshots: 10
}
```

The runtime MUST fail closed when limits are exceeded.

---

# 28. Security

Credentials MUST NOT be included in model observations unless the caller explicitly opts in.

Default behavior:

```text
password inputs → [REDACTED]
cookies → inaccessible
authorization headers → inaccessible
localStorage secrets → inaccessible
```

The runtime SHOULD support URL allowlists:

```ts
{
    allowedOrigins: [
        "https://example.com",
        "https://app.example.com"
    ]
}
```

Optional restrictions:

```text
allowDownloads
allowUploads
allowClipboard
allowFileSystem
allowRawCdp
allowNavigation
```

Raw CDP should be considered a privileged capability.

---

# 29. Logging

Structured logs MUST be JSON-compatible.

Example:

```json
{
    "timestamp": "...",
    "sessionId": "sess_01",
    "pageId": "page_01",
    "event": "action.completed",
    "action": "click",
    "target": "e17",
    "durationMs": 34
}
```

Never log:

* passwords;
* cookies;
* API keys;
* authorization headers;
* sensitive form contents by default.

---

# 30. AI/Harness Integration

The browser runtime must be usable as a normal Harness tool.

Example tool definition:

```json
{
    "name": "browser",
    "description": "Control and inspect a Chromium browser",
    "operations": [
        "open",
        "observe",
        "click",
        "type",
        "press",
        "scroll",
        "extract",
        "screenshot",
        "solve"
    ]
}
```

A harness should be able to maintain browser state outside the model context.

The model should receive:

```text
URL
page title
compact observation
task-relevant page state
last action
last result
```

rather than the entire browser history.

---

# 31. Context Efficiency

The runtime SHOULD expose:

```ts
observation.tokenEstimate
```

and:

```ts
observation.stats
```

Example:

```json
{
    "elements": 14,
    "visibleTextChars": 1240,
    "estimatedTokens": 510,
    "interactiveElements": 7
}
```

Optional compression:

```ts
page.observe({
    profile: "agent",
    maxTokens: 800
});
```

The observation builder may remove:

* offscreen content;
* irrelevant footer text;
* duplicate labels;
* hidden nodes;
* navigation noise;
* repeated DOM structures.

It MUST NOT remove elements required for executing the requested action.

---

# 32. Deterministic vs Agentic Example

## Programmatic

```ts
const page = await browser.page();

const state = await page.observe();

const search = state.elements.find(
    e => e.role === "textbox" && e.name === "Search"
);

await page.type(search.ref, "cats");
await page.press("Enter");
```

No model is involved.

## Agentic

```ts
await page.solve(
    "Search for cats and open the first result."
);
```

OpenJev selects the next action.

The runtime validates and executes it.

---

# 33. Hybrid Automation

This is the recommended usage pattern.

```ts
await page.navigate("https://example.com");

const state = await page.observe();

const button = state.elements.find(
    e => e.role === "button" &&
         e.name === "Continue"
);

if (button) {
    await page.click(button.ref);
} else {
    await page.solve(
        "Find the control that continues to the next step."
    );
}
```

Use deterministic code whenever the desired behavior is known.

Use OpenJev when the interface is uncertain.

This keeps automation:

* faster;
* cheaper;
* more reproducible;
* easier to test.

---

# 34. Retry Policy

Deterministic actions SHOULD retry only when the error is transient.

Retryable:

```text
STALE_OBSERVATION
PAGE_LOADING
TARGET_NOT_READY
NETWORK_TRANSIENT
```

Not automatically retryable:

```text
INVALID_SELECTOR
PERMISSION_DENIED
DOWNLOAD_BLOCKED
NAVIGATION_BLOCKED
AUTH_REQUIRED
```

Agentic retry:

```text
observe
→ re-plan
→ execute
```

must have a maximum retry count.

---

# 35. Action History

Store structured action history:

```json
{
    "step": 4,
    "action": {
        "kind": "click",
        "target": "e17"
    },
    "observationId": "obs_8",
    "result": "success",
    "durationMs": 28
}
```

The OpenJev planner may receive recent history but should not receive unlimited history.

Default:

```text
last 5 actions
```

Applications can increase this.

---

# 36. Recording / Replay

The runtime SHOULD support recording:

```text
session.json
observations/
screenshots/
actions.jsonl
events.jsonl
```

A replay mode should execute deterministic recorded actions against a test page.

Agent predictions should not be required for replay.

This enables:

* regression testing;
* debugging;
* browser benchmark datasets;
* harness evaluations.

---

# 37. Testing Strategy

## Unit tests

Test independently:

* fingerprint generation;
* observation parsing;
* action validation;
* locator resolution;
* stale detection;
* serialization;
* RPC protocol.

## Browser integration tests

Use local HTML fixtures.

Example:

```text
tests/browser/
    basic.html
    dynamic.html
    streaming.html
    modal.html
    iframe.html
    shadow-dom.html
    dropdown.html
```

No external website should be required for normal CI.

## Agent tests

Run OpenJev against recorded observations rather than requiring a live browser wherever possible.

```text
fixture observation
       ↓
OpenJev
       ↓
expected action
```

This separates:

```text
planner quality
```

from:

```text
browser correctness
```

---

# 38. Evaluation Metrics

The project MUST track:

### Reliability

```text
task success rate
stale recovery rate
invalid action rate
verification failure rate
```

### Performance

```text
browser calls/task
planner calls/task
mean latency
p50 latency
p95 latency
```

### Context efficiency

```text
observation tokens
total model tokens
tokens/task
```

### Agent quality

```text
correct action rate
correct target rate
completion rate
```

Do NOT optimize solely for latency.

A fast incorrect action is worse than a slower correct one.

---

# 39. CLI

Provide (one-shot commands connect → act → disconnect; `serve` owns a session):

```bash
abr observe <url> [--profile agent] [--no-managed] [--port 9222]
abr screenshot <url> --out shot.png
abr solve <url> "Complete this task" [--max-steps 30]

abr serve --rpc-port 8765 [--profile-dir <dir>] [--proxy-server <url>]
abr rpc page.create '{"url":"https://example.com"}' --rpc-port 8765
abr mcp                        # MCP stdio adapter (browser_* tools)

abr chrome --port 9222 [--profile-dir ./.abr-debug-profile]  # debuggable headful Chrome
abr replay <dir>               # deterministic replay of a recording
```

Example:

```bash
abr solve "https://example.com" "Find the search box, search for cats, and open the first result."
```

The CLI is primarily a debugging/interface layer.

The SDK remains the canonical API.

---

# 40. Local RPC API

The runtime server SHOULD listen on loopback only:

```text
127.0.0.1:<port>
```

Protocol:

```text
JSON-RPC 2.0
```

Example:

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "page.observe",
    "params": {
        "pageId": "page_1",
        "profile": "agent"
    }
}
```

Response:

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
        "observationId": "obs_17",
        "elements": []
    }
}
```

This is the integration boundary for:

* Python;
* Rust;
* Go;
* other Node applications;
* AI harnesses;
* external automation systems.

---

# 41. MCP Compatibility

MCP SHOULD be an adapter, not the runtime itself.

Possible tools:

```text
browser_open
browser_observe
browser_click
browser_type
browser_press
browser_scroll
browser_extract
browser_screenshot
browser_solve
```

MCP simply translates requests into the runtime API.

Architecture:

```text
MCP
 │
 ▼
Browser Runtime
 │
 ▼
CDP
```

Do not make the runtime internally dependent on MCP.

---

# 42. Planner Interface

OpenJev should be one implementation:

```ts
interface Planner {
    plan(input: PlannerInput): Promise<PlannerDecision>;
}
```

Implementations:

```text
OpenJevPlanner
MockPlanner
RulePlanner
FuturePlanner
```

Testing:

```ts
const planner = new MockPlanner([
    { kind: "click", target: "e1" },
    { kind: "type", target: "e2", text: "hello" }
]);
```

This makes the agent loop testable without any model.

---

# 43. Provider Abstraction

The OpenJev package SHOULD support:

```ts
interface DecisionProvider {
    decide(
        state: unknown,
        questions: unknown
    ): Promise<unknown>;
}
```

Supported providers may include:

```text
OpenJev local server
OpenJev-compatible HTTP endpoint
TypeSafe Jev
OpenRouter Jev
Mock provider
```

The browser runtime must not care which provider is used.

OpenJev currently exposes a System One-compatible `/v1/systemone` endpoint, while Jev itself is also available through a typed decision API. Keeping the planner behind a provider interface avoids coupling the project to either deployment path.

---

# 44. Recommended Agent Loop

Reference implementation:

```ts
async function solve(
    page: Page,
    goal: string
): Promise<SolveResult> {

    const started = Date.now();
    const history: ActionHistory = [];

    for (let step = 0; step < limits.maxSteps; step++) {

        checkTimeout();

        const observation =
            await page.observe({
                profile: "agent"
            });

        const plannerInput = {
            goal,
            observation,
            history: history.slice(-5)
        };

        const decision =
            await planner.plan(plannerInput);

        if (decision.action === "DONE") {

            const verification =
                await verifier.verify(
                    goal,
                    observation
                );

            if (verification.success) {
                return completed(...);
            }
        }

        const result =
            await actionEngine.execute(
                page,
                decision.action,
                observation
            );

        history.push({
            observationId:
                observation.observationId,
            action:
                decision.action,
            result
        });

        if (result.error === "STALE_OBSERVATION") {
            continue;
        }

        if (!result.ok) {
            return failed(...);
        }
    }

    return failed("MAX_STEPS");
}
```

The loop is intentionally simple.

Complexity belongs in:

```text
Observation
ActionEngine
Planner
Verifier
```

not in the solve loop.

---

# 45. Action Engine

The Action Engine is responsible for translating abstract actions into concrete browser operations.

Example:

```text
CLICK e17
   ↓
lookup e17
   ↓
verify observation still fresh
   ↓
resolve actual DOM node
   ↓
check visible
   ↓
check enabled
   ↓
check occlusion
   ↓
dispatch browser input
   ↓
record result
```

This is where most browser reliability logic belongs.

The model must never directly control the transport.

---

# 46. Page State Machine

The runtime should expose:

```text
CONNECTED
READY
NAVIGATING
LOADING
INTERACTING
WAITING
STALE
FAILED
CLOSED
```

Example:

```text
READY
 ↓
NAVIGATING
 ↓
LOADING
 ↓
READY
```

For agentic actions:

```text
READY
 ↓
PLANNING
 ↓
INTERACTING
 ↓
WAITING
 ↓
READY
```

---

# 47. Error Model

Errors must be typed.

```ts
BrowserError
├── ConnectionError
├── NavigationError
├── ObservationError
├── StaleObservationError
├── ElementNotFoundError
├── ElementNotInteractableError
├── TimeoutError
├── PlannerError
├── VerificationError
├── PermissionError
└── CapabilityError
```

Consumers can therefore write:

```ts
try {
    await page.click(ref);
} catch (err) {
    if (err instanceof StaleObservationError) {
        ...
    }
}
```

---

# 48. Minimal MVP

The first implementation should NOT attempt the entire specification.

MVP:

```text
1. Connect/launch Chromium
2. Page creation
3. Navigation
4. CDP transport
5. DOM observation
6. Interactive element indexing
7. ElementRef
8. Click
9. Type
10. Press
11. Scroll
12. Screenshot
13. Stale detection
14. Re-observation
15. OpenJev planner
16. solve()
17. JSON logging
```

Everything else can follow.

---

# 49. MVP Acceptance Test

The project is considered functional when this works:

```ts
const browser = await BrowserRuntime.connect({
    mode: "managed"
});

const page = await browser.createPage(
    "https://example.com"
);

const observation =
    await page.observe();

console.log(observation);

const result =
    await page.solve(
        "Open the More Information link."
    );

console.log(result);

await browser.disconnect();
```

Then test programmatic mode:

```ts
const page = await browser.createPage(
    "http://localhost:3000/test"
);

const state =
    await page.observe();

const input =
    state.elements.find(
        e => e.role === "textbox"
    );

await page.type(
    input.ref,
    "hello"
);
```

No AI should be required for the second test.

---

# 50. MVP Dynamic-DOM Acceptance Test

Test page:

```html
<button id="dynamic">
    Click me
</button>

<script>
setTimeout(() => {
    const old = document.getElementById("dynamic");
    old.replaceWith(
        old.cloneNode(true)
    );
}, 100);
</script>
```

Expected:

```text
observe()
↓
ref = e1
↓
DOM replacement
↓
click(e1)
↓
STALE_OBSERVATION
↓
observe()
↓
new ref
↓
click(new ref)
```

Agentic `solve()` should automatically recover.

---

# 51. Streaming Acceptance Test

Create a test page that progressively changes:

```text
Hello
Hello world
Hello world this
Hello world this is
Hello world this is complete
```

The runtime must support:

```ts
await page.wait({
    until: {
        kind: "text_stable",
        stableForMs: 500
    }
});
```

and return the final content.

---

# 52. Integration Contract

A consuming project should need only:

```bash
npm install agent-browser-runtime
```

and:

```ts
import {
    BrowserRuntime
} from "agent-browser-runtime";
```

The consuming project MUST NOT need to know:

* CDP session IDs;
* Browser Harness process details;
* DOM marker implementation;
* observation fingerprints;
* OpenJev request schemas;
* browser-launch flags.

Those remain internal.

---

# 53. What the Runtime Should Feel Like

The final product should feel roughly like this:

```ts
const browser = await BrowserRuntime.connect();

const page = await browser.open(
    "https://some-site.com"
);

// Normal automation
await page.navigate(...);
await page.click(...);
await page.type(...);

// Readable state
const pageState = await page.observe();

// Agentic fallback
await page.solve(
    "Find the settings menu and enable dark mode."
);

// Raw power when necessary
await browser.cdp(...);
```

That is the entire philosophy.

Simple interface outside.

Complex browser machinery inside.

---

# 54. Design Rules for Future Development

The following rules MUST be preserved.

### Rule 1

**Never couple application code to CDP.**

### Rule 2

**Never require AI for deterministic operations.**

### Rule 3

**Never let model output become executable browser code.**

### Rule 4

**Never trust an old ElementRef without freshness validation.**

### Rule 5

**Never treat `DONE` as proof of success.**

### Rule 6

**Never put the entire DOM into the model unless explicitly requested.**

### Rule 7

**Never make a website-specific adapter part of the browser core.**

### Rule 8

**Keep OpenJev replaceable.**

### Rule 9

**Keep the raw CDP escape hatch.**

### Rule 10

**Keep browser state outside the LLM context whenever possible.**

---

# 55. Suggested Development Order

## Phase 0 — Stealth transport (core)

Build:

```text
launch hygiene (new headless, AutomationControlled off, consistent UA/hints)
per-page evasion init scripts (webdriver/plugins/languages/chrome.runtime/...)
isolated-world evaluation, no Runtime.enable
humanized input (paths, jitter, timing)
stealth-check regression (sannysoft + real search round trip, re-run per Chrome bump)
```

## Phase 1 — Browser transport

Build:

```text
Chromium launch
Chrome attach
CDP connection
Page
Tab
Navigation
Screenshot
```

## Phase 2 — Observation

Build:

```text
DOM extraction
visible text
interactive controls
ElementRef
fingerprint
observation profiles
```

## Phase 3 — Deterministic automation

Build:

```text
click
type
press
scroll
select
wait
extract
```

## Phase 4 — Reliability

Build:

```text
stale detection
occlusion
visibility
retry
verification
timeouts
events
```

## Phase 5 — OpenJev

Build:

```text
Planner interface
OpenJev provider
action space
solve loop
verification
```

## Phase 6 — Integration

Build:

```text
CLI
JSON-RPC server
Python client
MCP adapter
```

## Phase 7 — Harness optimization

Build:

```text
token counting
compressed observations
record/replay
evaluation
benchmarks
```

---

# 56. Final Architecture

The intended final system is:

```text
                         ┌───────────────────────────┐
                         │     Consuming Project     │
                         │                           │
                         │  Automation / AI Harness  │
                         └─────────────┬─────────────┘
                                       │
                              Public Browser API
                                       │
                         ┌─────────────▼─────────────┐
                         │   Agent Browser Runtime   │
                         │                           │
                         │ Session / Tabs / Pages    │
                         │ Observation               │
                         │ Element References        │
                         │ Actions                   │
                         │ Wait / Verify             │
                         │ Event System               │
                         └───────┬──────────┬────────┘
                                 │          │
                           deterministic   optional
                              actions      OpenJev
                                 │          │
                                 └────┬─────┘
                                      │
                              Action Engine
                                      │
                              Transport Layer
                                      │
                         ┌────────────▼────────────┐
                         │ Browser Harness / CDP   │
                         └────────────┬────────────┘
                                      │
                                Chromium
                                      │
                                     Web
```

The important distinction is:

```text
Browser Runtime ≠ Browser Agent
```

The runtime is the reusable infrastructure.

The agent is merely one consumer of that infrastructure.

That means the same project can power:

```text
Python automation
Node automation
AI Harness
OpenJev agent
MCP
CLI
testing framework
web research agent
browser-based RPA
```

without changing the browser core.

---

# 57. Definition of Done

Version 0.1 is complete when:

* Chromium can be launched or attached;
* multiple pages can be controlled;
* programmatic navigation works;
* structured page observations work;
* interactive elements receive ephemeral refs;
* deterministic click/type/press/scroll work;
* stale observations are detected;
* dynamic DOM replacement can recover;
* screenshots work;
* the runtime can operate entirely without AI;
* OpenJev can select typed browser actions;
* agent actions are validated before execution;
* `DONE` requires verification;
* solve loops have step/time limits;
* raw CDP is available as an escape hatch;
* a local JSON-RPC interface exists (loopback only; serializable solve verifier);
* a minimal Python client can connect;
* standard fingerprint suites (e.g. sannysoft) show no bot tells;
* normal search engines serve results without bot blocks;
* input timing/geometry looks human rather than instant and pixel-perfect;
* all browser state remains external to LLM context;
* a consuming project can import the runtime without knowing its internal browser implementation.

The project should finish with a small, stable public API while allowing the internals to evolve.

The long-term objective is not:

> "a browser that can control DeepSeek."

It is:

> **a general browser execution runtime that deterministic software and AI agents can use interchangeably.**
