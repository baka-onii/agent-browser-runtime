// Public API (spec §§6,52 + design rules §54). No CDP/Jev internals leak here.
export { BrowserRuntime, type BrowserCapabilities } from "./browser.js";
export { Page, type ActionResult, type NavigationResult, type WaitCondition, type WaitResult } from "./page.js";
export type { ElementRef, Locator, ObservedElement } from "./element.js";
export type { BrowserAction } from "./action.js";
export type { PageObservation, ObservationProfile } from "./observation.js";
export type { BrowserEvent } from "./events.js";
export type {
  BrowserConfig, ConnectOptions, SolveOptions, NavigateOptions, ObserveOptions,
  ScreenshotOptions, WaitOptions, ExtractOptions, SelectOption, ScrollOptions,
} from "./config.js";
export type { SolveResult, SolveStatus } from "./solve.js";
export type { Planner, PlannerInput, PlannerDecision, ActionHistoryEntry, DecisionProvider } from "./planner/planner.js";
export { MockPlanner, RulePlanner } from "./planner/planner.js";
export { findChrome, chromeHelp } from "./transport.js";
export { RpcServer, type RpcVerifyDescriptor } from "./rpc/server.js";
export { RpcClient, RpcError, type RpcTarget } from "./rpc/client.js";
export { McpServer } from "./mcp/server.js";
export { Recorder, replay, type RecordedAction } from "./recording.js";
export { Metrics, type MetricsSummary } from "./metrics.js";
export { fileSink, teeSink } from "./logger.js";
export { OpenJevPlanner, buildActionSpace, MAX_TARGET_CHOICES } from "./planner/openjev.js";
export {
  BrowserError, ConnectionError, NavigationError, ObservationError, StaleObservationError,
  ElementNotFoundError, ElementNotInteractableError, TimeoutError, PlannerError,
  VerificationError, PermissionError, CapabilityError,
} from "./errors.js";
