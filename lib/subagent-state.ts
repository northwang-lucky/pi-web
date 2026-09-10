/**
 * Centralized globalThis state for the subagent subsystem.
 *
 * Three pieces of mutable state are needed across the subagent dispatch
 * and runtime modules:
 *
 *   - __piDispatchActive:    dispatch-id → parent-session-id (concurrency tracking)
 *   - __piSubagentRuns:      session-id → StoredSubagentExecution (active run registry)
 *   - __piSubagentStartingCounts: parent-session-id → count (slot reservation)
 *
 * Historically each piece lived in its own module with a standalone
 * if-not-then-new lazy initializer.  This module consolidates all three
 * into a single typed registry on globalThis so the initialization pattern
 * is defined once and the individual getters are thin one-liners.
 *
 * Hot-reload safety: the registry lives on globalThis, surviving Next.js
 * Turbopack HMR.  Module-level Maps would be recreated on every reload.
 *
 * Backward compatibility: the individual globalThis properties
 * (__piSubagentRuns, __piSubagentStartingCounts, __piDispatchActive) are
 * still set directly by tests (subagent-runtime.test.mjs lines 47, 54-55).
 * The getters therefore check the per-property slot first and fall back
 * to the registry only when the property is absent.
 */

// ---------------------------------------------------------------------------
// Registry type
// ---------------------------------------------------------------------------

interface SubagentStateRegistry {
  /** dispatch-id → parent-session-id */
  dispatchActive: Map<string, string>;
  /** session-id → StoredSubagentExecution */
  subagentRuns: Map<string, unknown>;
  /** parent-session-id → starting count */
  subagentStartingCounts: Map<string, number>;
}

declare global {
  var __piSubagentState: SubagentStateRegistry | undefined;
  var __piDispatchActive: Map<string, string> | undefined;
  var __piSubagentRuns: Map<string, unknown> | undefined;
  var __piSubagentStartingCounts: Map<string, number> | undefined;
}

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

function ensureRegistry(): SubagentStateRegistry {
  if (!globalThis.__piSubagentState) {
    globalThis.__piSubagentState = {
      dispatchActive: new Map(),
      subagentRuns: new Map(),
      subagentStartingCounts: new Map(),
    };
  }
  return globalThis.__piSubagentState;
}

// ---------------------------------------------------------------------------
// Individual getters — backward-compatible with direct globalThis assignment
// ---------------------------------------------------------------------------

/** Active dispatches keyed by dispatch-id (value = parent-session-id). */
export function getActiveDispatches(): Map<string, string> {
  if (!globalThis.__piDispatchActive) {
    globalThis.__piDispatchActive = ensureRegistry().dispatchActive;
  }
  return globalThis.__piDispatchActive;
}

/** Active subagent runs keyed by child session-id. */
export function getSubagentRuns(): Map<string, unknown> {
  if (!globalThis.__piSubagentRuns) {
    globalThis.__piSubagentRuns = ensureRegistry().subagentRuns as Map<string, unknown>;
  }
  return globalThis.__piSubagentRuns;
}

/** Per-parent starting-slot counts (reserveSubagentSlot bookkeeping). */
export function getSubagentStartingCounts(): Map<string, number> {
  if (!globalThis.__piSubagentStartingCounts) {
    globalThis.__piSubagentStartingCounts = ensureRegistry().subagentStartingCounts;
  }
  return globalThis.__piSubagentStartingCounts;
}
