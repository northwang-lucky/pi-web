import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The behavior tests below drive start() past the concurrency gate, which
// constructs real SDK services (settings, auth storage, model registry).
// Point the agent dir at an empty temp dir so the tests stay hermetic: they
// never read the developer's real ~/.pi/agent, and the background prompt in
// the completion path fails fast with "No API key found" instead of ever
// reaching a real provider.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-web-subagent-runtime-"));
process.on("exit", () => rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true }));

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");

// ---------------------------------------------------------------------------
// Helpers for behavior tests
// ---------------------------------------------------------------------------

/** Minimal fake parent that passes the alive/sessionFile guards in start(). */
function fakeParent(overrides = {}) {
  return {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sessionManager: {
        getSessionId: () => "parent-session",
        buildSessionContext: () => ({ messages: [] }),
      },
      model: undefined,
      agent: { state: undefined },
      sendCustomMessage: async () => {},
      ...overrides,
    },
  };
}

/** Inject fake active runs into globalThis so reserveSubagentSlot sees them. */
function injectActiveRuns(runs) {
  globalThis.__piSubagentRuns = new Map(
    runs.map((r) => [r.sessionId, { run: r, completion: Promise.resolve(r), abortRequested: false }]),
  );
}

/** Clear globalThis subagent state between tests. */
function clearSubagentState() {
  delete globalThis.__piSubagentRuns;
  delete globalThis.__piSubagentStartingCounts;
}

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.content, "Parser found");
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

// ---------------------------------------------------------------------------
// G4 — Effective model/thinking surfaced in SubagentRunInfo and resourceSnapshot
// ---------------------------------------------------------------------------

test("G4: runtime resolves model via three-level fallback before resourceSnapshot", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // The three-level fallback chain for model: request.model ?? profile.model
  // resolved through parseSubagentModel, falling back to parent.inner.model.
  assert.match(source, /parseSubagentModel\(parentModelRuntime, request\.model \?\? profile\.model\)/);
  assert.match(source, /parent\.inner\.model as ReturnType<ModelRuntime\["getModel"\]>/);

  // The three-level fallback chain for thinking: request → profile → parent state.
  assert.match(source, /request\.thinking \?\? profile\.thinking \?\? parent\.inner\.agent\.state\?\.thinkingLevel/);

  // Authoritative resolvedModel is surfaced into resourceSnapshot.
  assert.match(source, /model: effectiveModel/);
  assert.match(source, /thinking: thinking \?\? null/);

  // The resourceSnapshot block must contain model and thinking assignments.
  const snapshotStart = source.indexOf("resourceSnapshot:");
  const snapshotBlock = source.slice(snapshotStart, source.indexOf("};", snapshotStart) + 2);
  assert.match(snapshotBlock, /model: effectiveModel/);
  assert.match(snapshotBlock, /thinking: thinking \?\? null/);
});

test("G4: runtime puts effective model/thinking into initialRun lifecycle event", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // The initialRun object must carry model and thinking from the resolved values.
  const runStart = source.indexOf("const initialRun: SubagentRunInfo");
  const runBlock = source.slice(runStart, source.indexOf("};", runStart) + 2);
  assert.match(runBlock, /model: effectiveModel/);
  assert.match(runBlock, /thinking: thinking \?\? null/);
});

test("G4: dispatch module reads authoritative values from the run, not transitional fallback", async () => {
  const source = await readFile(new URL("./subagent-dispatch.ts", import.meta.url), "utf8");

  // After B4 the settle() function must read model/thinking directly from
  // the run object without falling back to params or parentState.
  assert.match(source, /effectiveModel: runExtra\.model \?\? ""/);
  assert.match(source, /effectiveThinking: runExtra\.thinking \?\? null/);

  // The old transitional fallback (params.model ?? parentState.model) must
  // have been removed.
  assert.doesNotMatch(source, /params\.model \?\? parentState\.model/);
  assert.doesNotMatch(source, /params\.thinking \?\? parentState\.thinking/);
});

// ---------------------------------------------------------------------------
// G5 — Configurable concurrency cap via dependencies injection
// ---------------------------------------------------------------------------

test("G5: runtime reads maxConcurrentSubagents from dependencies and passes to reserveSubagentSlot", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // The dependencies interface must declare getMaxConcurrentSubagents.
  assert.match(source, /getMaxConcurrentSubagents\?\(\): number/);

  // The start() function must read the configured value from dependencies.
  assert.match(source, /dependencies\.getMaxConcurrentSubagents/);

  // reserveSubagentSlot must accept maxConcurrent as a parameter.
  assert.match(source, /function reserveSubagentSlot\(parentSessionId: string, maxConcurrent: number\)/);

  // The error message must use the parameter, not the constant.
  assert.match(source, /at most \$\{maxConcurrent\} subagents/);
});

test("G5: runtime falls back to MAX_CONCURRENT_SUBAGENTS when dependency is absent", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // When getMaxConcurrentSubagents is not provided, the fallback must use
  // the module constant MAX_CONCURRENT_SUBAGENTS.
  assert.match(source, /getMaxConcurrent\?\.\(\) \?\? MAX_CONCURRENT_SUBAGENTS/);
});

// ---------------------------------------------------------------------------
// G5 — Behavior: configurable concurrency cap through start()
// ---------------------------------------------------------------------------

test("G5 behavior: N active runs block the (N+1)th start with the configured cap", async () => {
  clearSubagentState();
  try {
    const controller = createSubagentController({
      getSession: () => fakeParent(),
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
      getMaxConcurrentSubagents: () => 2,
    });

    // Simulate 2 active runs for this parent by injecting into globalThis.
    injectActiveRuns([
      { sessionId: "run-1", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "run-2", parentSessionId: "parent-session", status: "running", createdAt: "" },
    ]);

    // The 3rd start must be rejected with the configured cap of 2.
    await assert.rejects(
      controller.extensionRuntime.start({
        parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
        parentToolCallId: "call-3",
        profile: "explore",
        task: "Overflow",
        description: "Overflow",
      }),
      /at most 2 subagents/,
    );
  } finally {
    clearSubagentState();
  }
});

test("G5 behavior: missing getMaxConcurrentSubagents falls back to cap of 4", async () => {
  clearSubagentState();
  try {
    const controller = createSubagentController({
      getSession: () => fakeParent(),
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
      // No getMaxConcurrentSubagents — must fall back to 4.
    });

    // Simulate 4 active runs.
    injectActiveRuns([
      { sessionId: "r1", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "r2", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "r3", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "r4", parentSessionId: "parent-session", status: "running", createdAt: "" },
    ]);

    // The 5th start must be rejected with the default cap of 4.
    await assert.rejects(
      controller.extensionRuntime.start({
        parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
        parentToolCallId: "call-5",
        profile: "explore",
        task: "Overflow default",
        description: "Overflow default",
      }),
      /at most 4 subagents/,
    );
  } finally {
    clearSubagentState();
  }
});

test("G5 behavior: invalid (non-positive) cap falls back to 4", async () => {
  clearSubagentState();
  try {
    const controller = createSubagentController({
      getSession: () => fakeParent(),
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
      getMaxConcurrentSubagents: () => -1,
    });

    // Simulate 4 active runs — if cap fell back to 4, the 5th must be blocked.
    injectActiveRuns([
      { sessionId: "r1", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "r2", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "r3", parentSessionId: "parent-session", status: "running", createdAt: "" },
      { sessionId: "r4", parentSessionId: "parent-session", status: "running", createdAt: "" },
    ]);

    await assert.rejects(
      controller.extensionRuntime.start({
        parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
        parentToolCallId: "call-5",
        profile: "explore",
        task: "Overflow invalid",
        description: "Overflow invalid",
      }),
      /at most 4 subagents/,
    );
  } finally {
    clearSubagentState();
  }
});

test("G5 behavior: runs from a different parent do not count toward this parent's cap", async () => {
  clearSubagentState();
  try {
    const controller = createSubagentController({
      getSession: () => fakeParent(),
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
      getMaxConcurrentSubagents: () => 2,
    });

    // 2 active runs for a DIFFERENT parent — must not block this parent.
    injectActiveRuns([
      { sessionId: "r1", parentSessionId: "other-parent", status: "running", createdAt: "" },
      { sessionId: "r2", parentSessionId: "other-parent", status: "running", createdAt: "" },
    ]);

    // This parent has 0 active runs — start() must get past the cap check.
    // start() returns a SubagentExecution; the completion promise may reject
    // later at SDK calls, but start() itself must not throw a cap error.
    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call-1",
      profile: "explore",
      task: "Cross-parent",
      description: "Cross-parent",
    });

    // Verify start() returned successfully (past the cap check).
    assert.ok(handle.run, "start() must return a run object");
    assert.equal(typeof handle.run.sessionId, "string");
    assert.equal(handle.run.status, "running");
  } finally {
    clearSubagentState();
  }
});

// ---------------------------------------------------------------------------
// G4 — Behavior: three-level fallback for model/thinking
//
// The three-level fallback (request → profile → parent) runs inside start()
// at subagent-runtime.ts:165-182.  The resolved effectiveModel and thinking
// are local variables surfaced into SubagentRunInfo and resourceSnapshot.
//
// However, createAgentSessionServices (line 198) is the SDK wall: it needs
// real file-system access, model runtime, and settings infrastructure that
// cannot be faked through the existing dependency-injection seams.  The
// initialRun object (line 288) and onUpdate callback (line 328) that carry
// the resolved values are therefore unreachable through start().
//
// The deepest observable boundary through start() is:
//   - The thinking validation at line 166-168 (runs after fallback)
//   - The profile resolution via builtin profiles
//
// What remains unreachable and why:
//   - effectiveModel in SubagentRunInfo: local variable, never persisted
//     unless createAgentSessionFromServices succeeds (SDK wall)
//   - onUpdate callback with resolved initialRun: called at line 328,
//     which is after both SDK calls (lines 198 and 281)
//   - resourceSnapshot model/thinking: written to session file via
//     sessionManager.appendCustomEntry, which requires a real SessionManager
//
// These are already locked by source-inspection tests above and by the
// dispatch module's S4 test suite (which drives the fallback through a fake
// controller that implements the same three-level chain).
// ---------------------------------------------------------------------------

test("G4 behavior: thinking fallback reaches parent state when no request or profile value", async () => {
  clearSubagentState();
  try {
    // Parent has an invalid thinking level — start() must reject at the
    // thinking validation (line 166-168), proving the fallback resolved
    // to the parent's live value.
    const parent = fakeParent({
      agent: { state: { thinkingLevel: "invalid-level" } },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    // No request.thinking, no profile.thinking (builtin "explore" has none).
    // Fallback resolves to parent's "invalid-level" → validation rejects.
    await assert.rejects(
      controller.extensionRuntime.start({
        parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
        parentToolCallId: "call",
        profile: "explore",
        task: "Test thinking fallback",
        description: "Thinking fallback",
      }),
      /Invalid subagent thinking level: invalid-level/,
    );
  } finally {
    clearSubagentState();
  }
});

test("G4 behavior: valid request thinking bypasses parent's invalid thinking", async () => {
  clearSubagentState();
  try {
    // Parent has an invalid thinking level, but the request supplies a valid one.
    const parent = fakeParent({
      agent: { state: { thinkingLevel: "invalid-level" } },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    // Request thinking is valid — must NOT throw Invalid thinking level.
    // start() returns a SubagentExecution; the thinking validation passes
    // and the error (if any) comes later from SDK calls.
    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Test request thinking",
      description: "Request thinking",
      thinking: "high",
    });

    // Verify start() returned successfully (thinking validation passed).
    assert.ok(handle.run, "start() must return a run object");
    assert.equal(typeof handle.run.sessionId, "string");
    assert.equal(handle.run.status, "running");
  } finally {
    clearSubagentState();
  }
});
