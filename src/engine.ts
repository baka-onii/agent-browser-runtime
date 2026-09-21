// ActionEngine: abstract action -> concrete browser ops with freshness proof (spec §45).
// Freshness = pageKey + guard + live node (constraint 2). Model never touches transport.
import type { CdpTransport } from "./transport.js";
import type { ObservedAction } from "./element.js";
import { StaleObservationError, ElementNotInteractableError, ElementNotFoundError } from "./errors.js";

export interface FreshnessProof { page_key: unknown; guards: Record<string, unknown>; marker: unknown; }

export const POST_INPUT_WAIT_JS = `(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve(true)};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

export async function checkFresh(
  t: CdpTransport, sessionId: string, action: ObservedAction, proof: FreshnessProof, world: string | null = "abr",
): Promise<boolean> {
  if (action.kind === "scroll" || action.kind === "wait") return true;
  if (typeof action.node !== "number") return false;
  const expr = `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`;
  let cur: unknown;
  try { cur = await ev(t, sessionId, world, expr); } catch { return false; }
  const expected = [proof.page_key, (proof.guards as Record<string, unknown>)[String(action.node)]];
  return JSON.stringify(cur) === JSON.stringify(expected);
}

async function ev(t: CdpTransport, sessionId: string, world: string | null, expression: string, awaitPromise = false): Promise<unknown> {
  if (world) return t.evaluateInWorld(sessionId, world, expression, awaitPromise);
  return t.evaluate(sessionId, expression, awaitPromise);
}

/** Humanized click point: slight offset from center + curved multi-step move. */
export async function humanClick(
  t: CdpTransport, sessionId: string, x: number, y: number, humanize: boolean,
): Promise<void> {
  if (!humanize) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await t.sendSession(sessionId, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    return;
  }
  const jx = x + (Math.random() * 6 - 3), jy = y + (Math.random() * 6 - 3);
  const sx = Math.max(0, jx - 200 - Math.random() * 200), sy = Math.max(0, jy - 120 - Math.random() * 120);
  const steps = 6 + Math.floor(Math.random() * 5);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    // Quadratic bezier with slight upward bow for a natural arc.
    const cx = sx + (jx - sx) * k, cy = sy + (jy - sy) * k - Math.sin(k * Math.PI) * 14;
    await t.sendSession(sessionId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(cx), y: Math.round(cy) });
    await sleep(5 + Math.random() * 12);
  }
  await sleep(30 + Math.random() * 90);
  await t.sendSession(sessionId, "Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(jx), y: Math.round(jy), button: "left", clickCount: 1 });
  await sleep(40 + Math.random() * 80);
  await t.sendSession(sessionId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(jx), y: Math.round(jy), button: "left", clickCount: 1 });
}

export async function humanTypeKeys(
  t: CdpTransport, sessionId: string, text: string, humanize: boolean,
): Promise<void> {
  if (!humanize || text.length > 200) {
    await t.sendSession(sessionId, "Input.insertText", { text });
    return;
  }
  // Char-by-char for short strings (chat prompts, search queries); bulk insert for long bodies.
  for (const ch of text) {
    await t.sendSession(sessionId, "Input.insertText", { text: ch });
    await sleep(12 + Math.random() * 55);
  }
}

export async function executeObserved(
  t: CdpTransport, sessionId: string, action: ObservedAction, proof: FreshnessProof, text?: string,
  opts: { world?: string | null; humanize?: boolean; files?: string[] } = {},
): Promise<{ executed: string }> {
  const world = opts.world === undefined ? "abr" : opts.world;
  const humanize = opts.humanize !== false;
  if (!(await checkFresh(t, sessionId, action, proof, world))) {
    throw new StaleObservationError("obs_current", "Target changed or page mutated since observation");
  }
  if (action.kind === "wait") { await sleep(100); return { executed: action.id }; }
  if (action.kind === "scroll") {
    await t.sendSession(sessionId, "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta ?? 560 });
    if (humanize) await sleep(120 + Math.random() * 250);
    return { executed: action.id };
  }
  if (action.kind === "upload") {
    // Never click file inputs (opens an OS dialog). Set files directly via CDP.
    if (typeof action.node !== "number") throw new ElementNotInteractableError("Upload target lost its node");
    if (!opts.files || opts.files.length === 0) {
      throw new ElementNotInteractableError("File inputs require page.upload() with file paths");
    }
    const backend = await t.resolveBackendNode(sessionId, world, action.node);
    await t.sendSession(sessionId, "DOM.setFileInputFiles", { files: opts.files, backendNodeId: backend });
    if (humanize) await sleep(120 + Math.random() * 250);
    return { executed: action.id };
  }
  // Resolve + validate live node atomically in-page (geometry + occlusion + enabled)
  const target = (await ev(t, sessionId, world, `(action => {
    const e=window.__jevFast?.nodes.get(action.node);
    if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
        !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
    if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
    if (!e.contains(document.elementFromPoint(x,y))) return null;
    if (action.kind==='select') {
      if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
          !o.disabled && !o.closest('optgroup[disabled]'))) return null;
      e.value=action.value;
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return {x,y};
  })(${JSON.stringify({ node: action.node, kind: action.kind, value: action.value })})`)) as { x: number; y: number } | null;

  if (target === null) {
    if (action.kind === "select") throw new ElementNotInteractableError("Dropdown option not available; inspect before retrying");
    throw new StaleObservationError("obs_current", "Target changed, covered, or not interactable");
  }
  if (action.kind === "select") return { executed: action.id };
  const { x, y } = target;
  await humanClick(t, sessionId, x, y, humanize);
  if (action.kind === "fill") {
    if (typeof text !== "string" || text.length === 0) throw new ElementNotFoundError("TYPE_TEXT needs text from text helper");
    const mod = process.platform === "darwin" ? 4 : 2;
    await t.sendSession(sessionId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: mod, commands: ["selectAll"] });
    await t.sendSession(sessionId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: mod });
    if (humanize) await sleep(40 + Math.random() * 120);
    await humanTypeKeys(t, sessionId, text, humanize);
  }
  // Post-input useful-state wait (logged as read-only, after execution)
  try {
    await ev(t, sessionId, world, `(${POST_INPUT_WAIT_JS})(${JSON.stringify({ node: action.node, kind: action.kind })})`, true);
  } catch { /* best-effort */ }
  return { executed: action.id };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
