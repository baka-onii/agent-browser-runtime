"""Typed client for the Agent Browser Runtime loopback JSON-RPC server.

Stdlib only (urllib) — no third-party dependencies.

    from agent_browser_runtime import RpcClient

    c = RpcClient("http://127.0.0.1:8765")
    page = c.create_page("https://example.com")
    obs = c.observe(page["id"], "agent")
    box = next(e for e in obs["elements"] if e["role"] == "textbox")
    c.type(page["id"], box["ref"], "hello")
"""

from __future__ import annotations

import base64
import json
import urllib.request
from typing import Any, Optional


class RpcError(Exception):
    """JSON-RPC error from the server. Unknown observation IDs arrive with
    code -32603 and data {"errorCode": "STALE_OBSERVATION"}; known-but-mutated
    refs instead return {"ok": False, "error": "STALE_OBSERVATION"} as a result."""

    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


# ElementRef / Locator are plain dicts, e.g.
# {"id": "e7", "observationId": "obs_x", "pageId": "page_1"} or
# {"kind": "role", "role": "button", "name": "Send"}
Target = dict[str, Any]


class RpcClient:
    def __init__(self, base_url: str, timeout: float = 120.0):
        self._url = base_url.rstrip("/") + "/"
        self._timeout = timeout
        self._id = 0

    def _call(self, method: str, params: Optional[dict[str, Any]] = None) -> Any:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}).encode()
        req = urllib.request.Request(self._url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as res:
                data = json.loads(res.read().decode())
        except RpcError:
            raise
        except Exception as e:  # connection errors etc.
            raise RpcError(-32603, f"RPC transport failed: {e}")
        err = data.get("error")
        if err:
            raise RpcError(err.get("code", -32603), err.get("message", "RPC error"), err.get("data"))
        return data.get("result")

    # -- browser -----------------------------------------------------------
    def capabilities(self) -> dict[str, Any]:
        return self._call("browser.capabilities")

    def health(self) -> dict[str, Any]:
        return self._call("browser.health")

    def metrics(self) -> dict[str, Any]:
        return self._call("browser.metrics")

    def status(self) -> dict[str, Any]:
        return self._call("server.status")

    def shutdown(self) -> dict[str, Any]:
        return self._call("server.shutdown")

    def pages(self) -> list[dict[str, Any]]:
        return self._call("browser.pages")

    def close_page(self, page_id: str) -> dict[str, Any]:
        return self._call("browser.closePage", {"pageId": page_id})

    # -- pages -------------------------------------------------------------
    def create_page(self, url: Optional[str] = None) -> dict[str, Any]:
        return self._call("page.create", {"url": url} if url else {})

    def navigate(self, page_id: str, url: str, timeout_ms: Optional[int] = None) -> dict[str, Any]:
        p: dict[str, Any] = {"pageId": page_id, "url": url}
        if timeout_ms:
            p["timeoutMs"] = timeout_ms
        return self._call("page.navigate", p)

    def back(self, page_id: str) -> dict[str, Any]:
        return self._call("page.back", {"pageId": page_id})

    def forward(self, page_id: str) -> dict[str, Any]:
        return self._call("page.forward", {"pageId": page_id})

    def reload(self, page_id: str) -> dict[str, Any]:
        return self._call("page.reload", {"pageId": page_id})

    def observe(self, page_id: str, profile: str = "agent", max_tokens: Optional[int] = None) -> dict[str, Any]:
        p: dict[str, Any] = {"pageId": page_id, "profile": profile}
        if max_tokens:
            p["maxTokens"] = max_tokens
        return self._call("page.observe", p)

    def click(self, page_id: str, target: Target) -> dict[str, Any]:
        return self._call("page.click", {"pageId": page_id, "target": target})

    def type(self, page_id: str, target: Target, text: str) -> dict[str, Any]:
        return self._call("page.type", {"pageId": page_id, "target": target, "text": text})

    def press(self, page_id: str, key: str) -> dict[str, Any]:
        return self._call("page.press", {"pageId": page_id, "key": key})

    def scroll(self, page_id: str, x: Optional[int] = None, y: Optional[int] = None,
               delta_x: Optional[int] = None, delta_y: Optional[int] = None) -> dict[str, Any]:
        p: dict[str, Any] = {"pageId": page_id}
        if x is not None:
            p["x"] = x
        if y is not None:
            p["y"] = y
        if delta_x is not None:
            p["deltaX"] = delta_x
        if delta_y is not None:
            p["deltaY"] = delta_y
        return self._call("page.scroll", p)

    def select(self, page_id: str, target: Target, option: str) -> dict[str, Any]:
        return self._call("page.select", {"pageId": page_id, "target": target, "option": option})

    def hover(self, page_id: str, target: Target) -> dict[str, Any]:
        return self._call("page.hover", {"pageId": page_id, "target": target})

    def focus(self, page_id: str, target: Target) -> dict[str, Any]:
        return self._call("page.focus", {"pageId": page_id, "target": target})

    def upload(self, page_id: str, target: Target, files: list[str]) -> dict[str, Any]:
        return self._call("page.upload", {"pageId": page_id, "target": target, "files": files})

    def cookies(self, page_id: str) -> list[dict[str, Any]]:
        return self._call("page.cookies", {"pageId": page_id})

    def set_cookies(self, page_id: str, cookies: list[dict[str, Any]]) -> dict[str, Any]:
        return self._call("page.setCookies", {"pageId": page_id, "cookies": cookies})

    def clear_cookies(self, page_id: str) -> dict[str, Any]:
        return self._call("page.clearCookies", {"pageId": page_id})

    def extract(self, page_id: str, target: Optional[Target] = None, max_chars: Optional[int] = None) -> dict[str, Any]:
        p: dict[str, Any] = {"pageId": page_id}
        if target is not None:
            p["target"] = target
        if max_chars:
            p["maxChars"] = max_chars
        return self._call("page.extract", p)

    def screenshot(self, page_id: str) -> bytes:
        """PNG bytes."""
        res = self._call("page.screenshot", {"pageId": page_id})
        return base64.b64decode(res["dataBase64"])

    def evaluate(self, page_id: str, expression: str) -> Any:
        return self._call("page.evaluate", {"pageId": page_id, "expression": expression})

    def wait(self, page_id: str, condition: dict[str, Any], timeout_ms: Optional[int] = None) -> dict[str, Any]:
        p: dict[str, Any] = {"pageId": page_id, "condition": condition}
        if timeout_ms:
            p["timeoutMs"] = timeout_ms
        return self._call("page.wait", p)

    def frames(self, page_id: str) -> list[dict[str, Any]]:
        return self._call("page.frames", {"pageId": page_id})

    def solve(self, page_id: str, task: str, max_steps: Optional[int] = None,
              max_elapsed_ms: Optional[int] = None, verify: Optional[dict[str, str]] = None) -> dict[str, Any]:
        """verify is a serializable descriptor, e.g. {"textContains": "done"}.
        Unverified DONE never reports completed (server-side rule)."""
        p: dict[str, Any] = {"pageId": page_id, "task": task}
        if max_steps:
            p["maxSteps"] = max_steps
        if max_elapsed_ms:
            p["maxElapsedMs"] = max_elapsed_ms
        if verify:
            p["verify"] = verify
        return self._call("page.solve", p)
