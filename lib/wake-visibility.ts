// Wake-round visibility: a subagent-notification wake round runs entirely
// server-side and leaves no wrapper-level prompt_done for this page. While
// the page sits idle with its SSE closed, the sidebar running snapshot and
// tab/network hard signals are the only hints that content landed in the
// session file — this module decides when an idle page should silently pull
// that missed content.

export type IdleReconciliationTrigger = "tab_visible" | "network_online" | "running_snapshot_gone";

// Focus churn fires hard signals constantly; most of the time nothing happened.
export const IDLE_RECONCILIATION_MIN_INTERVAL_MS = 5_000;

export interface ShouldReconcileIdleSessionParams {
  trigger: IdleReconciliationTrigger;
  /** The page knows a wrapper-level prompt run is active on this session. */
  localRunActive: boolean;
  /** The page knows a shell command is active on this session. */
  bashRunning: boolean;
  /** A streaming bubble is currently mounted. */
  streamingActive: boolean;
  /** The latest sidebar snapshot lists this session as running. */
  snapshotRunning: boolean;
  /** Ms since the last idle reconciliation fetch; null when never fetched. */
  msSinceLastReconciliation: number | null;
}

export function shouldReconcileIdleSession(params: ShouldReconcileIdleSessionParams): boolean {
  // Active runs own their reconciliation path (periodic state reconcile plus
  // the agent_settled reload); a silent fetch here would race the live stream.
  if (params.localRunActive || params.bashRunning || params.streamingActive) return false;

  // The snapshot transitioned running → gone while this page never attached:
  // the strongest signal that a wake round finished off-screen. The fetch is
  // idempotent, so skip throttling and reconcile on every transition.
  if (params.trigger === "running_snapshot_gone") return true;

  // While the snapshot still lists the session, the SSE attach path owns the
  // updates; fetching here would fight the live stream.
  if (params.snapshotRunning) return false;

  // Hard signals are throttled: they fire on every focus change.
  return params.msSinceLastReconciliation === null
    || params.msSinceLastReconciliation >= IDLE_RECONCILIATION_MIN_INTERVAL_MS;
}
