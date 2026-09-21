// Config types (spec §§20,26,27,28).
import { PermissionError } from "./errors.js";
export interface BrowserConfig {
  mode: "attach" | "managed";
  browser?: {
    executablePath?: string;
    profileDir?: string;
    remoteDebugPort?: number;
    wsUrl?: string;
    args?: string[];
  };
  headless?: boolean;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  allowedOrigins?: string[];
  allowRawCdp?: boolean;
  allowNavigation?: boolean;
  allowDownloads?: boolean;
  allowUploads?: boolean;
  /** Download directory. If set, downloads are auto-allowed there (else Chrome default). */
  downloadsPath?: string;
  /** JS dialog policy: dismiss (default) | accept | manual (leave open for harness). */
  dialogs?: "dismiss" | "accept" | "manual";
  /** HTTP(S) proxy, e.g. "http://127.0.0.1:8080". Auth is not yet supported. */
  proxy?: { server: string };
  /** Locale, e.g. "en-US". Sets --lang, Accept-Language override and number/date formats. */
  locale?: string;
  /** IANA timezone, e.g. "America/New_York". Overrides per-page clock. */
  timezone?: string;
  /** Append JSON log lines to this file (in addition to console). */
  logFile?: string;
  /** Connection budget for launch/attach (default 15s). */
  connectTimeoutMs?: number;
  /** Human-like transport hygiene (default true). Set false for pixel-instant deterministic tests. */
  stealth?: boolean;
  /** Humanized input paths/timing (default true). Set false for instant dispatch. */
  humanize?: boolean;
}

export interface ConnectOptions extends BrowserConfig {}

export interface SolveOptions {
  maxSteps?: number;
  maxElapsedMs?: number;
  maxPlannerCalls?: number;
  signal?: AbortSignal;
  verifier?: (goal: string, obs: import("./observation.js").PageObservation) => Promise<boolean> | boolean;
  useModelVerifier?: boolean;
  planner?: import("./planner/planner.js").Planner;
  historyLimit?: number;
}

export interface NavigateOptions { timeoutMs?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle"; signal?: AbortSignal; }
export interface ObserveOptions {
  profile?: "minimal" | "agent" | "text" | "full";
  maxTokens?: number;
  screenshot?: boolean;
  signal?: AbortSignal;
}
export interface ScreenshotOptions { fullPage?: boolean; signal?: AbortSignal; }
export interface WaitOptions { timeoutMs?: number; signal?: AbortSignal; }
export interface ExtractOptions { maxChars?: number; signal?: AbortSignal; }
export type SelectOption = string | { value?: string; label?: string; index?: number };
export interface ScrollOptions { x?: number; y?: number; deltaX?: number; deltaY?: number; signal?: AbortSignal; }

export const DEFAULT_LIMITS = { maxSteps: 30, maxElapsedMs: 60_000, maxPlannerCalls: 30, maxScreenshots: 10 };

export function assertOriginAllowed(url: string, allowed?: string[]): void {
  if (!allowed || allowed.length === 0) return;
  let ok = false;
  try {
    const u = new URL(url);
    ok = allowed.some((a) => {
      try {
        const au = new URL(a);
        return u.origin === au.origin;
      } catch { return u.href.startsWith(a); }
    });
  } catch { ok = false; }
  if (!ok) {
    throw new PermissionError(`Navigation blocked: ${url} not in allowedOrigins`);
  }
}
