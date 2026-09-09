import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// ---------------------------------------------------------------------------
// These tests import createDispatchRuntime from lib/subagent-dispatch.ts, which
// does not exist yet. That is the intended red state: every suite below must
// fail because the module or a named export is missing. When the implementation
// lands in P2, these suites turn green without any test-file edits.
// ---------------------------------------------------------------------------

let createDispatchRuntime;
try {
  ({ createDispatchRuntime } = await jiti.import("./subagent-dispatch.ts"));
} catch {
  // Expected during the red phase: the module does not exist yet.
}

// ---------------------------------------------------------------------------
// Fake dependency factories
//
// Each factory follows the hand-written-mock convention of
// lib/subagent-runtime.test.mjs: plain objects injected into the unit under
// test, with no mocking library. Every fake records the values it was given so
// assertions can verify that the dispatch module drove real resolution logic
// through the injected dependencies — never hard-coded fixture strings.
// ---------------------------------------------------------------------------

/**
 * Build a fake controller whose start() resolves the effective model/thinking
 * through the same three-level fallback the production controller uses
 * (dispatch param → profile → parent session state), and whose tools go through
 * the allow/deny/exclude pipeline. The completion promise is controllable so
 * tests can drive the child lifecycle deterministically.
 */
function createFakeController({
  profile = {},
  extensionToolNames = [],
} = {}) {
  const calls = { start: [], steer: [], abort: [] };
  const runs = new Map();
  let runId = 0;

  return {
    extensionRuntime: {
      start: async (request) => {
        calls.start.push(request);
        const id = `child-${++runId}`;

        // Three-level fallback: dispatch param → profile → parent session state.
        const parentState = request._getParentState?.() ?? {};
        const effectiveModel =
          request.model ?? profile.model ?? parentState.model ?? "zenmux/default";
        const effectiveThinking =
          request.thinking ?? profile.thinking ?? parentState.thinking ?? null;

        // Tool resolution: per-dispatch allowlist (or profile defaults), merged
        // with extension tool names, minus disallowedTools, minus the reserved
        // control-tool base set, minus any caller-supplied excludeTools.
        const baseTools = request.tools ?? profile.tools ?? [];
        const merged = [...new Set([...baseTools, ...extensionToolNames])];
        const disallowed = new Set(request.disallowedTools ?? []);
        const reserved = new Set(["Agent", "get_subagent_result", "steer_subagent"]);
        const excluded = new Set(request.excludeTools ?? []);
        const effectiveTools = merged.filter(
          (tool) => !disallowed.has(tool) && !reserved.has(tool) && !excluded.has(tool),
        );

        const run = {
          sessionId: id,
          sessionPath: `/tmp/${id}.jsonl`,
          parentSessionId: request.parentContext?.sessionManager?.sessionId ?? "parent-session",
          parentToolCallId: request.parentToolCallId,
          profile: request.profile,
          description: request.description,
          task: request.task,
          runInBackground: request.runInBackground ?? false,
          status: "running",
          createdAt: new Date().toISOString(),
          model: effectiveModel,
          thinking: effectiveThinking,
          tools: effectiveTools,
        };

        let resolveCompletion;
        const completion = new Promise((resolve) => { resolveCompletion = resolve; });
        runs.set(id, { run, resolveCompletion });

        return { run, completion };
      },
    },
    steer: async (sessionId, message) => {
      calls.steer.push([sessionId, message]);
    },
    abort: async (sessionId) => {
      calls.abort.push(sessionId);
    },
    _calls: calls,
    _runs: runs,
    _resolve: (sessionId, status = "completed", result = "Done") => {
      const stored = runs.get(sessionId);
      if (stored) {
        stored.resolveCompletion({
          ...stored.run,
          status,
          completedAt: new Date().toISOString(),
          ...(result ? { result } : {}),
        });
      }
    },
  };
}

/**
 * Build a dispatch runtime from injected deps. Mirrors the production binding
 * in lib/subagent-dispatch.ts, but every dependency is supplied by the test.
 */
function createTestRuntime({
  controller,
  maxConcurrentSubagents = 4,
  parentState = { model: "zenmux/parent-model", thinking: "low" },
  sessionRoot,
} = {}) {
  return createDispatchRuntime({
    getController: () => controller,
    readSettings: () => ({ maxConcurrentSubagents }),
    getParentState: () => parentState,
    sessionRoot,
  });
}

// ---------------------------------------------------------------------------
// S1 — Programmatic dispatch API: start / steer / abort / signal linkage
// ---------------------------------------------------------------------------

test("S1: createDispatchRuntime exposes startSubagentDispatch", () => {
  const runtime = createTestRuntime({ controller: createFakeController() });
  assert.equal(typeof runtime.startSubagentDispatch, "function");
});

test("S1: foreground dispatch awaits completion and returns final text", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Summarise the repo",
    description: "Summarise",
    runInBackground: false,
  });

  assert.equal(typeof handle.dispatchId, "string");
  assert.equal(typeof handle.completion, "object");

  // Drive the child to completion through the fake controller.
  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Summary text");

  const event = await handle.completion;
  assert.equal(event.phase, "completed");
  assert.equal(event.result, "Summary text");
});

test("S1: background dispatch returns a handle immediately", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Investigate the parser",
    description: "Investigate",
    runInBackground: true,
  });

  assert.equal(typeof handle.dispatchId, "string");
  assert.equal(typeof handle.steer, "function");
  assert.equal(typeof handle.abort, "function");
  assert.equal(typeof handle.completion, "object");

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Investigation done");
  await handle.completion;
});

test("S1: steer forwards a message to the child session", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Investigate the parser",
    description: "Investigate",
    runInBackground: true,
  });

  await handle.steer("Focus on the error path");
  assert.deepEqual(controller._calls.steer[0][1], "Focus on the error path");

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");
  await handle.completion;
});

test("S1: abort terminates the child and marks the event aborted", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "A long-running task",
    description: "Long task",
    runInBackground: true,
  });

  await handle.abort();
  assert.equal(controller._calls.abort.length, 1);

  const event = await handle.completion;
  assert.equal(event.phase, "aborted");
});

test("S1: parent AbortSignal aborts the child", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });
  const signal = new AbortController();

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "A task we will cancel",
    description: "Cancel task",
    runInBackground: false,
    signal: signal.signal,
  });

  signal.abort();

  const event = await handle.completion;
  assert.equal(event.phase, "aborted");
});

// ---------------------------------------------------------------------------
// S2 — Per-dispatch tool allowlist resolution
// ---------------------------------------------------------------------------

test("S2: per-dispatch tools allowlist reaches the child session", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Read-only scan",
    description: "Scan",
    tools: ["read", "bash", "grep"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Scanned");

  const event = await handle.completion;
  assert.ok(Array.isArray(event.effectiveTools), "event should expose effectiveTools");
  assert.ok(event.effectiveTools.includes("read"), "read must remain allowed");
  assert.ok(event.effectiveTools.includes("bash"), "bash must remain allowed");
  assert.ok(event.effectiveTools.includes("grep"), "grep must remain allowed");
});

test("S2: extension tool names are admitted into the effective tool set", async () => {
  const controller = createFakeController({ extensionToolNames: ["lsp_diagnostics", "lsp_fix"] });
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "LSP-assisted scan",
    description: "LSP scan",
    tools: ["read", "lsp_diagnostics"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "LSP scan done");

  const event = await handle.completion;
  assert.ok(event.effectiveTools.includes("lsp_diagnostics"), "extension tool must be admitted");
});

test("S2: disallowedTools takes precedence over tools", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Read-only scan",
    description: "Scan",
    tools: ["read", "bash", "grep"],
    disallowedTools: ["bash"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Scanned");

  const event = await handle.completion;
  assert.ok(Array.isArray(event.effectiveTools), "event should expose effectiveTools");
  assert.ok(!event.effectiveTools.includes("bash"), "bash must be excluded by disallowedTools");
  assert.ok(event.effectiveTools.includes("read"), "read must remain allowed");
});

test("S2: regression lock — no tools param yields profile-default tools", async () => {
  const profileTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const controller = createFakeController({
    profile: { tools: profileTools },
  });
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Profile-default tools",
    description: "Defaults",
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");

  const event = await handle.completion;
  assert.ok(Array.isArray(event.effectiveTools), "event should expose effectiveTools");
  assert.deepEqual(event.effectiveTools.sort(), [...profileTools].sort());
});

// ---------------------------------------------------------------------------
// S3 — Extension allow/deny and excludeTools resolution
// ---------------------------------------------------------------------------

test("S3: caller-supplied excludeTools extends the reserved base set", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Custom exclude",
    description: "Exclude",
    excludeTools: ["bash"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");

  const event = await handle.completion;
  assert.ok(Array.isArray(event.effectiveTools), "event should expose effectiveTools");
  assert.ok(!event.effectiveTools.includes("bash"), "caller-excluded bash must be gone");
  // Reserved names must still be excluded even though the caller only named "bash".
  assert.ok(!event.effectiveTools.includes("Agent"), "Agent must remain excluded by the base set");
  assert.ok(!event.effectiveTools.includes("get_subagent_result"), "get_subagent_result must remain excluded");
  assert.ok(!event.effectiveTools.includes("steer_subagent"), "steer_subagent must remain excluded");
});

test("S3: reserved tool names are always excluded regardless of caller input", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller });

  // Caller tries to pass the reserved names through tools; they must still be
  // excluded by the base set.
  const handle = await runtime.startSubagentDispatch("parent-session", {
    task: "Attempt reserved injection",
    description: "Reserved",
    tools: ["read", "Agent", "get_subagent_result", "steer_subagent"],
    runInBackground: true,
  });

  const childSessionId = controller._calls.start[0].sessionId;
  controller._resolve(childSessionId, "completed", "Done");

  const event = await handle.completion;
  assert.ok(!event.effectiveTools.includes("Agent"), "Agent must be excluded even when named in tools");
  assert.ok(!event.effectiveTools.includes("get_subagent_result"), "get_subagent_result must be excluded");
  assert.ok(!event.effectiveTools.includes("steer_subagent"), "steer_subagent must be excluded");
  assert.ok(event.effectiveTools.includes("read"), "non-reserved tools must survive");
});

// ---------------------------------------------------------------------------
// S4 — Lifecycle events carry effective model / thinking (three-level fallback)
// ---------------------------------------------------------------------------

test("S4: effectiveModel falls back param → profile → parent session", async () => {
  // Case A: explicit dispatch model wins.
  const controllerA = createFakeController({ profile: { model: "zenmux/profile-model" } });
  const runtimeA = createTestRuntime({
    controller: controllerA,
    parentState: { model: "zenmux/parent-model", thinking: null },
  });
  const handleA = await runtimeA.startSubagentDispatch("parent-session", {
    task: "Model override",
    description: "Model override",
    model: "zenmux/claude-sonnet-4-6",
    runInBackground: true,
  });
  const childA = controllerA._calls.start[0].sessionId;
  controllerA._resolve(childA, "completed", "Done");
  const eventA = await handleA.completion;
  assert.equal(eventA.effectiveModel, "zenmux/claude-sonnet-4-6");

  // Case B: no dispatch model → profile model wins.
  const controllerB = createFakeController({ profile: { model: "zenmux/profile-model" } });
  const runtimeB = createTestRuntime({
    controller: controllerB,
    parentState: { model: "zenmux/parent-model", thinking: null },
  });
  const handleB = await runtimeB.startSubagentDispatch("parent-session", {
    task: "Profile model",
    description: "Profile model",
    runInBackground: true,
  });
  const childB = controllerB._calls.start[0].sessionId;
  controllerB._resolve(childB, "completed", "Done");
  const eventB = await handleB.completion;
  assert.equal(eventB.effectiveModel, "zenmux/profile-model");

  // Case C: no dispatch model, no profile model → parent session model wins.
  const controllerC = createFakeController({ profile: {} });
  const runtimeC = createTestRuntime({
    controller: controllerC,
    parentState: { model: "zenmux/parent-model", thinking: null },
  });
  const handleC = await runtimeC.startSubagentDispatch("parent-session", {
    task: "Parent model",
    description: "Parent model",
    runInBackground: true,
  });
  const childC = controllerC._calls.start[0].sessionId;
  controllerC._resolve(childC, "completed", "Done");
  const eventC = await handleC.completion;
  assert.equal(eventC.effectiveModel, "zenmux/parent-model");
});

test("S4: effectiveThinking falls back param → profile → parent session", async () => {
  // Case A: explicit dispatch thinking wins.
  const controllerA = createFakeController({ profile: { thinking: "medium" } });
  const runtimeA = createTestRuntime({
    controller: controllerA,
    parentState: { model: "zenmux/default", thinking: "low" },
  });
  const handleA = await runtimeA.startSubagentDispatch("parent-session", {
    task: "Thinking override",
    description: "Thinking override",
    thinking: "high",
    runInBackground: true,
  });
  const childA = controllerA._calls.start[0].sessionId;
  controllerA._resolve(childA, "completed", "Done");
  const eventA = await handleA.completion;
  assert.equal(eventA.effectiveThinking, "high");

  // Case B: no dispatch thinking → profile thinking wins.
  const controllerB = createFakeController({ profile: { thinking: "medium" } });
  const runtimeB = createTestRuntime({
    controller: controllerB,
    parentState: { model: "zenmux/default", thinking: "low" },
  });
  const handleB = await runtimeB.startSubagentDispatch("parent-session", {
    task: "Profile thinking",
    description: "Profile thinking",
    runInBackground: true,
  });
  const childB = controllerB._calls.start[0].sessionId;
  controllerB._resolve(childB, "completed", "Done");
  const eventB = await handleB.completion;
  assert.equal(eventB.effectiveThinking, "medium");

  // Case C: no dispatch thinking, no profile thinking → parent session thinking wins.
  const controllerC = createFakeController({ profile: {} });
  const runtimeC = createTestRuntime({
    controller: controllerC,
    parentState: { model: "zenmux/default", thinking: "low" },
  });
  const handleC = await runtimeC.startSubagentDispatch("parent-session", {
    task: "Parent thinking",
    description: "Parent thinking",
    runInBackground: true,
  });
  const childC = controllerC._calls.start[0].sessionId;
  controllerC._resolve(childC, "completed", "Done");
  const eventC = await handleC.completion;
  assert.equal(eventC.effectiveThinking, "low");
});

// ---------------------------------------------------------------------------
// S5 — Concurrency cap is enforced
// ---------------------------------------------------------------------------

test("S5: N+1 concurrent dispatches throw once the cap is reached", async () => {
  const controller = createFakeController();
  const runtime = createTestRuntime({ controller, maxConcurrentSubagents: 2 });

  const handles = [];
  for (let i = 0; i < 2; i++) {
    handles.push(await runtime.startSubagentDispatch("parent-session", {
      task: `Concurrent task ${i}`,
      description: `Concurrent ${i}`,
      runInBackground: true,
    }));
  }

  // The third must throw.
  await assert.rejects(
    runtime.startSubagentDispatch("parent-session", {
      task: "Overflow task",
      description: "Overflow",
      runInBackground: true,
    }),
    /at most 2 subagents/,
  );

  // Clean up: resolve the in-flight runs so the cap releases.
  for (const handle of handles) {
    const childSessionId = controller._calls.start[handles.indexOf(handle)].sessionId;
    controller._resolve(childSessionId, "completed", "Done");
    await handle.completion;
  }
});

test("S5: missing or invalid maxConcurrentSubagents falls back to 4", async () => {
  const controller = createFakeController();
  // Simulate a malformed settings reader that returns a non-positive value;
  // the dispatch module must fall back to the default cap of 4.
  const runtime = createDispatchRuntime({
    getController: () => controller,
    readSettings: () => ({ maxConcurrentSubagents: -1 }),
    getParentState: () => ({ model: "zenmux/default", thinking: null }),
  });

  const handles = [];
  for (let i = 0; i < 4; i++) {
    handles.push(await runtime.startSubagentDispatch("parent-session-fallback", {
      task: `Fallback task ${i}`,
      description: `Fallback ${i}`,
      runInBackground: true,
    }));
  }

  await assert.rejects(
    runtime.startSubagentDispatch("parent-session-fallback", {
      task: "Overflow fallback",
      description: "Overflow fallback",
      runInBackground: true,
    }),
    /at most 4 subagents/,
  );

  for (const handle of handles) {
    const childSessionId = controller._calls.start[handles.indexOf(handle)].sessionId;
    controller._resolve(childSessionId, "completed", "Done");
    await handle.completion;
  }
});

// ---------------------------------------------------------------------------
// S6 — Ephemeral dispatch leaves no .jsonl
// ---------------------------------------------------------------------------

test("S6: ephemeral dispatch creates no .jsonl file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-ephemeral-dispatch-"));
  try {
    const controller = createFakeController();
    const runtime = createTestRuntime({ controller, sessionRoot: root });

    const handle = await runtime.startSubagentDispatch("parent-session", {
      task: "Fire-and-forget",
      description: "Ephemeral",
      ephemeral: true,
      runInBackground: true,
    });

    const childSessionId = controller._calls.start[0].sessionId;
    controller._resolve(childSessionId, "completed", "Done");

    const event = await handle.completion;
    assert.equal(event.phase, "completed");

    // No new .jsonl should appear under the session directory.
    const sessions = await SessionManager.list(root);
    assert.equal(sessions.length, 0, "ephemeral dispatch must not persist a .jsonl");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("S6: non-ephemeral dispatch does persist a .jsonl file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-persisted-dispatch-"));
  const sessionDir = join(root, "sessions");
  try {
    const controller = createFakeController();
    const runtime = createTestRuntime({ controller, sessionRoot: root });

    const handle = await runtime.startSubagentDispatch("parent-session", {
      task: "Persisted run",
      description: "Persisted",
      ephemeral: false,
      runInBackground: true,
    });

    const childSessionId = controller._calls.start[0].sessionId;
    controller._resolve(childSessionId, "completed", "Done");

    await handle.completion;

    const sessions = await SessionManager.list(root, sessionDir);
    assert.ok(sessions.length > 0, "non-ephemeral dispatch must leave a .jsonl");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
