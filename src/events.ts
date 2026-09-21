// Structured event system (spec §25).
export type BrowserEvent =
  | "browser.connected" | "browser.disconnected"
  | "page.created" | "page.closed" | "page.navigated"
  | "observation.created" | "observation.invalidated"
  | "action.started" | "action.completed" | "action.failed"
  | "planner.started" | "planner.completed"
  | "wait.started" | "wait.completed"
  | "download.completed"
  | "dialog.opened" | "dialog.handled"
  | "task.started" | "task.completed" | "task.failed";

export interface BrowserEventPayload {
  timestamp: string;
  sessionId?: string;
  pageId?: string;
  event: BrowserEvent;
  [k: string]: unknown;
}

export type EventHandler = (e: BrowserEventPayload) => void;
export type Unsubscribe = () => void;

export class EventBus {
  private handlers = new Map<BrowserEvent, Set<EventHandler>>();
  private anyHandlers = new Set<EventHandler>();
  on(event: BrowserEvent, cb: EventHandler): Unsubscribe {
    let s = this.handlers.get(event);
    if (!s) { s = new Set(); this.handlers.set(event, s); }
    s.add(cb);
    return () => { s!.delete(cb); };
  }
  /** Subscribe to every event (used by RPC/SSE fan-out). */
  onAny(cb: EventHandler): Unsubscribe {
    this.anyHandlers.add(cb);
    return () => { this.anyHandlers.delete(cb); };
  }
  emit(event: BrowserEvent, fields: Record<string, unknown> = {}): void {
    const payload: BrowserEventPayload = {
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    };
    const s = this.handlers.get(event);
    if (s) for (const h of [...s]) { try { h(payload); } catch { /* listener errors never break runtime */ } }
    for (const h of [...this.anyHandlers]) { try { h(payload); } catch { /* ignore */ } }
  }
}
