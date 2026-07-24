/**
 * Nagios numeric state codes and their mapping onto the Watcher severity
 * model. Host and service checks use different code spaces.
 */
import { SEVERITY } from './severity.js';

export const HOST_STATE = Object.freeze({
  UP: 0,
  DOWN: 1,
  UNREACHABLE: 2,
});

export const SERVICE_STATE = Object.freeze({
  OK: 0,
  WARNING: 1,
  CRITICAL: 2,
  UNKNOWN: 3,
});

export const HOST_STATE_NAME = Object.freeze(['UP', 'DOWN', 'UNREACHABLE']);
export const SERVICE_STATE_NAME = Object.freeze(['OK', 'WARNING', 'CRITICAL', 'UNKNOWN']);

/**
 * Map a Nagios state to a Watcher severity, or null when the state is
 * healthy (which resolves any open alert for that object).
 * UNREACHABLE maps to warning — the dependency engine will usually suppress
 * it under the parent's critical alert anyway.
 */
export function severityFor(isHost, state) {
  if (isHost) {
    if (state === HOST_STATE.DOWN) return SEVERITY.CRITICAL;
    if (state === HOST_STATE.UNREACHABLE) return SEVERITY.WARNING;
    return null;
  }
  if (state === SERVICE_STATE.CRITICAL) return SEVERITY.CRITICAL;
  if (state === SERVICE_STATE.WARNING) return SEVERITY.WARNING;
  if (state === SERVICE_STATE.UNKNOWN) return SEVERITY.INFO;
  return null;
}

export function stateName(isHost, state) {
  return (isHost ? HOST_STATE_NAME : SERVICE_STATE_NAME)[state] ?? `STATE_${state}`;
}
