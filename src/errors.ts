// Typed error hierarchy (spec §47).
export class BrowserError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserError";
    this.code = code;
  }
}
export class ConnectionError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("CONNECTION_ERROR", m, o); this.name = "ConnectionError"; }
}
export class NavigationError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("NAVIGATION_ERROR", m, o); this.name = "NavigationError"; }
}
export class ObservationError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("OBSERVATION_ERROR", m, o); this.name = "ObservationError"; }
}
export class StaleObservationError extends BrowserError {
  readonly observationId: string;
  constructor(observationId: string, m = "Stale observation") {
    super("STALE_OBSERVATION", `${m} (observation ${observationId})`);
    this.name = "StaleObservationError";
    this.observationId = observationId;
  }
}
export class ElementNotFoundError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("ELEMENT_NOT_FOUND", m, o); this.name = "ElementNotFoundError"; }
}
export class ElementNotInteractableError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("ELEMENT_NOT_INTERACTABLE", m, o); this.name = "ElementNotInteractableError"; }
}
export class TimeoutError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("TIMEOUT", m, o); this.name = "TimeoutError"; }
}
export class PlannerError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("PLANNER_ERROR", m, o); this.name = "PlannerError"; }
}
export class VerificationError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("VERIFICATION_ERROR", m, o); this.name = "VerificationError"; }
}
export class PermissionError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("PERMISSION_DENIED", m, o); this.name = "PermissionError"; }
}
export class CapabilityError extends BrowserError {
  constructor(m: string, o?: ErrorOptions) { super("CAPABILITY_UNSUPPORTED", m, o); this.name = "CapabilityError"; }
}

export function isRetryableCode(code: string): boolean {
  return code === "STALE_OBSERVATION" || code === "PAGE_LOADING" ||
    code === "TARGET_NOT_READY" || code === "NETWORK_TRANSIENT";
}
