import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./wake-visibility.ts");
}

function params(overrides = {}) {
  return {
    trigger: "tab_visible",
    localRunActive: false,
    bashRunning: false,
    streamingActive: false,
    snapshotRunning: false,
    msSinceLastReconciliation: null,
    ...overrides,
  };
}

test("skips idle reconciliation while the page knows an active run", async () => {
  const { shouldReconcileIdleSession } = await loadSubject();

  // An active local run owns its own reconciliation path (periodic reconcile
  // plus the agent_settled reload); a silent fetch would race the live stream.
  assert.equal(shouldReconcileIdleSession(params({ localRunActive: true })), false);
  assert.equal(shouldReconcileIdleSession(params({ bashRunning: true })), false);
  assert.equal(shouldReconcileIdleSession(params({ streamingActive: true })), false);
});

test("reconciles immediately when the running snapshot reports gone after a wake round", async () => {
  const { shouldReconcileIdleSession } = await loadSubject();

  // The snapshot transitioned running → gone while this page never attached:
  // the strongest signal that a wake round finished off-screen.
  assert.equal(
    shouldReconcileIdleSession(params({ trigger: "running_snapshot_gone" })),
    true,
  );
  // Not throttled: the wake round happens once and the fetch is idempotent.
  assert.equal(
    shouldReconcileIdleSession(params({
      trigger: "running_snapshot_gone",
      msSinceLastReconciliation: 50,
    })),
    true,
  );
});

test("throttles tab-visible and network-online reconciliation", async () => {
  const { shouldReconcileIdleSession, IDLE_RECONCILIATION_MIN_INTERVAL_MS } = await loadSubject();

  // First hard signal with no previous fetch reconciles right away.
  assert.equal(shouldReconcileIdleSession(params({ trigger: "tab_visible" })), true);
  assert.equal(shouldReconcileIdleSession(params({ trigger: "network_online" })), true);

  // Once the minimum interval has elapsed, focus churn reconciles again.
  assert.equal(
    shouldReconcileIdleSession(params({
      trigger: "tab_visible",
      msSinceLastReconciliation: IDLE_RECONCILIATION_MIN_INTERVAL_MS,
    })),
    true,
  );

  // Within the interval nothing new is assumed: every focus change must not
  // refetch the whole session file.
  assert.equal(
    shouldReconcileIdleSession(params({
      trigger: "tab_visible",
      msSinceLastReconciliation: IDLE_RECONCILIATION_MIN_INTERVAL_MS - 1,
    })),
    false,
  );
  assert.equal(
    shouldReconcileIdleSession(params({
      trigger: "network_online",
      msSinceLastReconciliation: 1,
    })),
    false,
  );
});

test("does not duplicate reconciliation while the snapshot still reports running", async () => {
  const { shouldReconcileIdleSession } = await loadSubject();

  // While the snapshot lists the session, the SSE attach path owns updates;
  // a fetch here would fight the live stream.
  assert.equal(
    shouldReconcileIdleSession(params({ snapshotRunning: true, trigger: "tab_visible" })),
    false,
  );
  assert.equal(
    shouldReconcileIdleSession(params({ snapshotRunning: true, trigger: "network_online" })),
    false,
  );
});

