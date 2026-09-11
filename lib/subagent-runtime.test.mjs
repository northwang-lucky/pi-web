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

const { createSubagentController, extensionFilterKey, filterExtensionsBySource } =
  await createJiti(import.meta.url).import("./subagent-runtime.ts");

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
  // the typed SubagentRunInfo fields without falling back to params or
  // parentState.  No `as unknown as` cast is used.
  assert.match(source, /effectiveModel: run\.model \?\? ""/);
  assert.match(source, /effectiveThinking: run\.thinking \?\? null/);

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
// at subagent-runtime.ts. With the hermetic PI_CODING_AGENT_DIR set at the top
// of this file, start() completes the SDK calls with fakes, so the resolved
// values ARE directly observable:
//   - handle.run is the initialRun SubagentRunInfo carrying model/thinking
//   - request.onUpdate fires synchronously with the same initialRun payload
//
// What remains genuinely unreachable in unit tests (locked instead by the
// source-inspection tests above and the dispatch module's S4 suite):
//   - resourceSnapshot model/thinking: persisted via sessionManager
//     .appendCustomEntry into the child session file, which requires a real
//     persisted SessionManager to inspect
//   - parent model resolution through the real model registry: unit fakes
//     supply the parent model object directly instead of a live ModelRuntime
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
    // The parent's live model is the final fallback for the model chain.
    const parent = fakeParent({
      agent: { state: { thinkingLevel: "invalid-level" } },
      model: { provider: "parentprov", id: "parentmodel" },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    const updates = [];
    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Test request thinking",
      description: "Request thinking",
      thinking: "high",
      onUpdate: (run) => updates.push(run),
    });

    // Direct assertions on the authoritative resolved values:
    // thinking — request level wins the chain; model — no request/profile
    // value, so the parent's live model is the effective one.
    assert.ok(handle.run, "start() must return a run object");
    assert.equal(handle.run.status, "running");
    assert.equal(handle.run.thinking, "high");
    assert.equal(handle.run.model, "parentprov/parentmodel");
    // onUpdate fires with the same initialRun payload before start returns.
    assert.equal(updates.length, 1);
    assert.equal(updates[0].thinking, "high");
    assert.equal(updates[0].model, "parentprov/parentmodel");
    assert.equal(updates[0].sessionId, handle.run.sessionId);
  } finally {
    clearSubagentState();
  }
});

test("G4 behavior: request model wins the fallback chain via the parent model runtime", async () => {
  clearSubagentState();
  try {
    // The parent's modelRuntime resolves the requested provider/modelId; the
    // parent's own live model must NOT win when the request names a model.
    const parent = fakeParent({
      model: { provider: "parentprov", id: "parentmodel" },
      modelRuntime: {
        getModel: (provider, modelId) =>
          provider === "reqprov" && modelId === "reqmodel"
            ? { provider: "reqprov", id: "reqmodel" }
            : undefined,
        getModels: () => [],
        // createAgentSessionServices refreshes the runtime it is handed.
        refresh: async () => {},
      },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Test request model",
      description: "Request model",
      model: "reqprov/reqmodel",
    });

    assert.equal(handle.run.model, "reqprov/reqmodel");
  } finally {
    clearSubagentState();
  }
});

test("G4 behavior: unresolvable request model rejects with a not-found error", async () => {
  clearSubagentState();
  try {
    const parent = fakeParent({
      model: { provider: "parentprov", id: "parentmodel" },
      modelRuntime: { getModel: () => undefined, getModels: () => [] },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    await assert.rejects(
      controller.extensionRuntime.start({
        parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
        parentToolCallId: "call",
        profile: "explore",
        task: "Test bad model",
        description: "Bad model",
        model: "nosuch/nosuch",
      }),
      /Subagent model not found: nosuch\/nosuch/,
    );
  } finally {
    clearSubagentState();
  }
});

// ---------------------------------------------------------------------------
// G6 — Ephemeral subagent sessions
// ---------------------------------------------------------------------------

test("G6: source — ephemeral flag branches SessionManager.create vs inMemory", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // The runtime must read request.ephemeral and branch.
  assert.match(source, /const ephemeral = request\.ephemeral \?\? false/);

  // Ephemeral true must call SessionManager.inMemory().
  assert.match(source, /SessionManager\.inMemory\(parent\.cwd/);

  // Non-ephemeral must call SessionManager.create().
  assert.match(source, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);

  // The ternary must select between the two.
  assert.match(source, /ephemeral\s*\n\s*\?\s*SessionManager\.inMemory/);
});

test("G6: source — ephemeral audit metadata written to parent session, not child", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // When ephemeral, metadata goes to parent.inner.sessionManager.
  assert.match(source, /if \(ephemeral\) \{[\s\S]*?parent\.inner\.sessionManager\.appendCustomEntry\(SUBAGENT_META_TYPE, metadata\)/);

  // When non-ephemeral, metadata goes to the child sessionManager.
  assert.match(source, /else \{[\s\S]*?sessionManager\.appendCustomEntry\(SUBAGENT_META_TYPE, metadata\)/);

  // appendSessionInfo only called for non-ephemeral.
  assert.match(source, /sessionManager\.appendSessionInfo\(metadata\.description\)/);
});

test("G6: source — ephemeral result metadata written to parent session", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // Ephemeral result goes to parent.
  assert.match(source, /if \(ephemeral\) \{[\s\S]*?parent\.inner\.sessionManager\.appendCustomEntry\(SUBAGENT_RESULT_TYPE, persisted\)/);

  // Non-ephemeral result goes to child.
  assert.match(source, /else \{[\s\S]*?sessionManager\.appendCustomEntry\(SUBAGENT_RESULT_TYPE, persisted\)/);
});

test("G6: source — ephemeral flag on StartSubagentRequest", async () => {
  const extSource = await readFile(new URL("./subagent-extension.ts", import.meta.url), "utf8");
  assert.match(extSource, /ephemeral\?\s*:\s*boolean/);
});

test("G6: dispatch module forwards ephemeral on the request", async () => {
  const dispatchSource = await readFile(new URL("./subagent-dispatch.ts", import.meta.url), "utf8");

  // The dispatch module must forward ephemeral to the controller.
  assert.match(dispatchSource, /ephemeral,/);

  // The transitional self-built SessionManager must be removed.
  assert.doesNotMatch(dispatchSource, /childSessionManager/);
  assert.doesNotMatch(dispatchSource, /dispatch_header/);
});

// ---------------------------------------------------------------------------
// G6 — Behavior: ephemeral vs non-ephemeral session creation
//
// These tests exercise the real start() path with SDK services (hermetic
// PI_CODING_AGENT_DIR at file top).  Ephemeral start creates an in-memory
// SessionManager; non-ephemeral creates a persisted one.
// ---------------------------------------------------------------------------

test("G6 behavior: ephemeral start uses an in-memory SessionManager (not persisted)", async () => {
  clearSubagentState();
  try {
    const parent = fakeParent({
      model: { provider: "testprov", id: "testmodel" },
      modelRuntime: {
        getModel: (provider, modelId) =>
          provider === "testprov" && modelId === "testmodel"
            ? { provider: "testprov", id: "testmodel" }
            : undefined,
        getModels: () => [],
        refresh: async () => {},
      },
      sessionManager: {
        getSessionId: () => "parent-session",
        buildSessionContext: () => ({ messages: [] }),
        appendCustomEntry: () => "entry-id",
        appendSessionInfo: () => "info-id",
      },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call-ephemeral",
      profile: "explore",
      task: "Ephemeral task",
      description: "Ephemeral test",
      ephemeral: true,
    });

    assert.equal(handle.run.status, "running");
    assert.equal(typeof handle.run.sessionId, "string");

    // In-memory sessions produce an empty sessionPath (inner.sessionFile is
    // undefined, sessionManager.getSessionFile() returns undefined, fallback
    // is "").
    assert.equal(handle.run.sessionPath, "",
      "ephemeral session must have an empty session path (in-memory)");
  } finally {
    clearSubagentState();
  }
});

test("G6 behavior: non-ephemeral start uses a persisted SessionManager (real file path)", async () => {
  clearSubagentState();
  try {
    const parent = fakeParent({
      model: { provider: "testprov", id: "testmodel" },
      modelRuntime: {
        getModel: (provider, modelId) =>
          provider === "testprov" && modelId === "testmodel"
            ? { provider: "testprov", id: "testmodel" }
            : undefined,
        getModels: () => [],
        refresh: async () => {},
      },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call-persisted",
      profile: "explore",
      task: "Persisted task",
      description: "Persisted test",
      ephemeral: false,
    });

    assert.equal(handle.run.status, "running");
    assert.equal(typeof handle.run.sessionId, "string");

    // Non-ephemeral sessions use SessionManager.create which produces
    // a real session file path (even if the SDK delays flushing to disk).
    // The run's sessionPath must be a non-empty string.
    assert.ok(handle.run.sessionPath,
      "non-ephemeral session must have a session path");
  } finally {
    clearSubagentState();
  }
});

test("G6 behavior: ephemeral audit metadata routed to parent sessionManager", async () => {
  clearSubagentState();
  try {
    const parentEntries = [];
    let parentSessionInfoCalls = 0;
    const parent = fakeParent({
      model: { provider: "testprov", id: "testmodel" },
      modelRuntime: {
        getModel: (provider, modelId) =>
          provider === "testprov" && modelId === "testmodel"
            ? { provider: "testprov", id: "testmodel" }
            : undefined,
        getModels: () => [],
        refresh: async () => {},
      },
      sessionManager: {
        getSessionId: () => "parent-session",
        buildSessionContext: () => ({ messages: [] }),
        appendCustomEntry: (type, data) => { parentEntries.push({ type, data }); return "entry-id"; },
        appendSessionInfo: () => { parentSessionInfoCalls += 1; return "info-id"; },
      },
    });
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call-audit",
      profile: "explore",
      task: "Audit test",
      description: "Audit routing",
      ephemeral: true,
    });

    assert.equal(handle.run.status, "running");

    // The parent sessionManager must have received the SUBAGENT_META_TYPE
    // custom entry (audit metadata routed to parent for ephemeral sessions).
    const metaEntry = parentEntries.find((e) => e.type === "pi-web:subagent");
    assert.ok(metaEntry, "ephemeral audit metadata must be written to parent sessionManager");
    assert.equal(metaEntry.data.parentSessionId, "parent-session");
    assert.equal(metaEntry.data.parentToolCallId, "call-audit");
    assert.equal(metaEntry.data.profile, "explore");
    assert.equal(metaEntry.data.description, "Audit routing");

    // appendSessionInfo must NOT be called on the parent: session info is
    // child-owned, and an ephemeral child never persists one.
    assert.equal(parentSessionInfoCalls, 0,
      "ephemeral start must not write session info through the parent");
  } finally {
    clearSubagentState();
  }
});

// ---------------------------------------------------------------------------
// File-path extension filtering regression (ST4 slice 4 — obs C fix)
//
// Adjudication ruling 2: extension filter key becomes
//   npm: → package name, file path → basename without extension.
// Both `extensions` and `denyExtensions` match against that key.
//
// Tests drive the real exported functions extensionFilterKey and
// filterExtensionsBySource — no production logic is duplicated.
// ---------------------------------------------------------------------------

test("file-path extension key derivation: basename sans extension", () => {
  assert.equal(
    extensionFilterKey("/home/user/.pi/extensions/smoke-test.js"),
    "smoke-test",
  );
  assert.equal(
    extensionFilterKey("/home/user/.pi/extensions/smoke-test.ts"),
    "smoke-test",
  );
  assert.equal(
    extensionFilterKey("/abs/path/.agents/extensions/my-ext"),
    "my-ext",
  );
  assert.equal(
    extensionFilterKey("/abs/path/.agents/extensions/my-ext.mjs"),
    "my-ext",
  );
});

test("npm extension key derivation unchanged", () => {
  assert.equal(extensionFilterKey("npm:@scope/my-pkg@1.0.0"), "@scope/my-pkg");
  assert.equal(extensionFilterKey("npm:my-pkg@2.3.4"), "my-pkg");
  assert.equal(extensionFilterKey("npm:@scope/utils@2.0.0"), "@scope/utils");
});

test("file-path extension: allow direction — basename whitelist admits file-path extension", () => {
  const extensions = [
    { sourceInfo: { source: "/abs/.pi/extensions/smoke-test.js" }, tools: new Map([["smoke_probe", {}]]) },
    { sourceInfo: { source: "npm:@scope/lsp-tools@1.0.0" }, tools: new Map([["lsp_diag", {}]]) },
  ];

  const filtered = filterExtensionsBySource(extensions, { allow: ["smoke-test"] });

  assert.equal(filtered.length, 1, "only smoke-test should survive allow filter");
  assert.ok(filtered[0].tools.has("smoke_probe"));
});

test("file-path extension: deny direction — basename blacklist excludes file-path extension", () => {
  const extensions = [
    { sourceInfo: { source: "/abs/.pi/extensions/smoke-test.js" }, tools: new Map([["smoke_probe", {}]]) },
    { sourceInfo: { source: "npm:@scope/lsp-tools@1.0.0" }, tools: new Map([["lsp_diag", {}]]) },
  ];

  const filtered = filterExtensionsBySource(extensions, { deny: ["smoke-test"] });

  assert.equal(filtered.length, 1, "only lsp-tools should survive deny filter");
  assert.ok(filtered[0].tools.has("lsp_diag"));
});

test("file-path extension: allow + deny combined", () => {
  const extensions = [
    { sourceInfo: { source: "/abs/.pi/extensions/smoke-test.js" }, tools: new Map([["smoke_probe", {}]]) },
    { sourceInfo: { source: "/abs/.pi/extensions/other-tool.ts" }, tools: new Map([["other_tool", {}]]) },
    { sourceInfo: { source: "npm:@scope/lsp-tools@1.0.0" }, tools: new Map([["lsp_diag", {}]]) },
  ];

  const filtered = filterExtensionsBySource(extensions, {
    allow: ["smoke-test", "other-tool"],
    deny: ["other-tool"],
  });

  assert.equal(filtered.length, 1, "only smoke-test should survive allow+deny");
  assert.ok(filtered[0].tools.has("smoke_probe"));
});

// Real SDK shape guardrail (2.2 P1): auto-discovered extensions carry
// sourceInfo.source === "auto" and only sourceInfo.path holds the file path.
// The f7bb362 regression (key derived from source alone) passed every
// idealized-shape test above; this case pins the production shape so any
// revert to source-only key derivation fails here.
test("real SDK shape: source 'auto' with path keys the filter", () => {
  const loaded = [
    {
      sourceInfo: {
        source: "auto",
        path: "/home/u/.pi/agent/extensions/smoke-harness.js",
      },
      tools: new Map([["smoke_probe", {}]]),
    },
  ];

  assert.equal(
    filterExtensionsBySource(loaded, { deny: ["smoke-harness"] }).length,
    0,
    "deny by basename must exclude an auto-discovered file-path extension",
  );
  assert.equal(
    filterExtensionsBySource(loaded, { allow: ["smoke-harness"] }).length,
    1,
    "allow by basename must admit an auto-discovered file-path extension",
  );
});

// ---------------------------------------------------------------------------
// G2 runtime pin: empty dispatch tools falls back to profile.tools
//
// The pipeline (resolveSubagentResources) returns [] when dispatchTools is
// an explicit empty array.  The runtime layer at subagent-runtime.ts:318
// applies the fallback:
//
//   const baseTools = pipelinePlan.effectiveTools.length > 0
//     ? pipelinePlan.effectiveTools
//     : profile.tools;
//
// This test pins that ternary by dispatching tools:[] through the real
// start() path and asserting that activeTools carries the profile's tools.
// ---------------------------------------------------------------------------

test("G2 runtime pin: tools:[] falls back to profile.tools at runtime layer", async () => {
  clearSubagentState();
  try {
    const parent = fakeParent();
    const controller = createSubagentController({
      getSession: () => parent,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    const handle = await controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent-session" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Empty tools fallback",
      description: "Fallback",
      tools: [],
    });

    // The "explore" profile carries PRESET_READ_ONLY = ["read","grep","find","ls"].
    // Despite dispatch tools being [], the runtime must fall back to profile.tools.
    assert.ok(Array.isArray(handle.run.activeTools), "activeTools must be an array");
    assert.ok(handle.run.activeTools.length > 0,
      "activeTools must not be empty — runtime fell back to profile.tools");
    assert.ok(handle.run.activeTools.includes("read"),
      "profile tool 'read' must survive the runtime fallback");
    assert.ok(handle.run.activeTools.includes("grep"),
      "profile tool 'grep' must survive the runtime fallback");
  } finally {
    clearSubagentState();
  }
});
