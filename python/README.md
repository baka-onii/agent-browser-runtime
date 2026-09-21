# agent-browser-runtime (Python client)

Typed client for the Agent Browser Runtime loopback JSON-RPC server. Stdlib only.

```bash
pip install ./python            # or: pip install -e ./python
abr serve --rpc-port 8765       # start the server (Node side owns the browser)
```

```python
from agent_browser_runtime import RpcClient

c = RpcClient("http://127.0.0.1:8765")
page = c.create_page("https://example.com")
obs = c.observe(page["id"], "agent")
box = next(e for e in obs["elements"] if e["role"] == "textbox")
c.type(page["id"], box["ref"], "hello")
c.press(page["id"], "Enter")
print(c.extract(page["id"])["text"][:500])
```

Notes:

- Element refs are ephemeral (`{"id", "observationId", "pageId"}`): re-`observe()` after DOM
  changes. Unknown observation IDs raise `RpcError` (`data["errorCode"] == "STALE_OBSERVATION"`);
  known-but-mutated refs return `{"ok": False, "error": "STALE_OBSERVATION"}`.
- `solve()` takes a serializable verifier (`{"urlContains": ..., "textContains": ...}`),
  never a callback — unverified `DONE` never reports `completed`.
- `screenshot()` returns PNG bytes.
