"""Live Python client test: fixture server + node RPC server + round trip.

Run from repo root:  python python/tests/test_live.py
Requires: node deps installed (npm install), Chrome installed.
"""
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "python"))

from agent_browser_runtime import RpcClient, RpcError  # noqa: E402

failures = 0


def check(name, ok, extra=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'} {name} {extra}")
    if not ok:
        failures += 1


FIXTURES = os.path.join(ROOT, "tests", "browser")
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES)
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{httpd.server_address[1]}"

NPX = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
node = subprocess.Popen(
    [NPX, "tsx", "scripts/rpc-serve.ts"],  # Chrome auto-detected server-side
    cwd=ROOT, stdout=subprocess.PIPE, text=True, stderr=subprocess.STDOUT,
)
try:
    line = ""
    for _ in range(600):
        chunk = node.stdout.readline()
        if not chunk:
            break
        if "RPC_PORT=" in chunk:
            line = chunk.strip()
            break
    assert "RPC_PORT=" in line, f"server did not print port (last line: {line!r})"
    port = int(line.split("RPC_PORT=")[1])
    print(f"rpc server: http://127.0.0.1:{port}/")
    c = RpcClient(f"http://127.0.0.1:{port}")

    caps = c.capabilities()
    check("capabilities", caps.get("cdp") is True and caps.get("stealth") is True)
    st = c.status()
    check("status", st.get("ok") is True and st.get("pages") == 0, json.dumps(st))
    page = c.create_page(f"{base}/basic.html")
    pid = page["id"]
    check("create", bool(pid), pid)
    obs = c.observe(pid, "agent")
    check("observe", len(obs["elements"]) >= 2, f"{len(obs['elements'])} els")
    box = next(e for e in obs["elements"] if e["role"] == "textbox")
    check("type", c.type(pid, box["ref"], "py-hello")["ok"])
    check("value", c.evaluate(pid, "document.querySelector('input')?.value") == "py-hello")
    btn = next(e for e in c.observe(pid)["elements"] if e["role"] == "button")
    check("click", c.click(pid, btn["ref"])["ok"])
    check("extract", "Basic" in c.extract(pid)["text"])
    check("screenshot", len(c.screenshot(pid)) > 1000)
    check("wait", c.wait(pid, {"kind": "text_present", "text": "Basic"}, 5000)["ok"])
    solved = c.solve(pid, "noop", max_steps=2, verify={"textContains": "Basic"})
    check("solve+verify", solved["status"] == "completed", solved["status"])
    try:
        c.click(pid, {"id": "zzz", "observationId": "nope", "pageId": pid})
        check("bad ref errors", False)
    except RpcError as e:
        check("bad ref errors", (e.data or {}).get("errorCode", "") == "STALE_OBSERVATION" or "STALE" in str(e), str(e))
    check("close", c.close_page(pid)["ok"])
except Exception as e:
    failures += 1
    print("HARNESS ERROR", repr(e)[:300])
finally:
    node.kill()
    httpd.shutdown()

print("PY ALL PASS" if failures == 0 else f"{failures} FAILURES")
sys.exit(0 if failures == 0 else 1)
